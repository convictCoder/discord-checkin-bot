import {
  Client,
  GatewayIntentBits,
  EmbedBuilder,
  ActivityType,
  Partials,
} from "discord.js";
import schedule from "node-schedule";
import "dotenv/config";
import { StandupCopilot } from "./standup.js";

export default class Bot {
  constructor(
    token,
    channelId,
    responseChannelId,
    checkInChannelId,
    questions
  ) {
    if (!checkInChannelId && !process.env.STANDUP_CHANNEL_ID) {
      throw new Error("CHECK_IN_CHANNEL_ID or STANDUP_CHANNEL_ID is required");
    }
    this.token = token;
    this.channelId = channelId;
    this.responseChannelId = responseChannelId;
    this.checkInChannelId = checkInChannelId;
    this.questions = questions;
    this.scheduledJobs = [];
    this.retryAttempts = 3;
    this.retryDelay = 5 * 60 * 1000; // 5 minutes
    this.client = new Client({
      partials: [Partials.Channel],
      intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.GuildMembers,
        GatewayIntentBits.DirectMessages,
        GatewayIntentBits.MessageContent,
        GatewayIntentBits.GuildMessageReactions,
      ],
    });
    this.standup = process.env.STANDUP_CHANNEL_ID ? new StandupCopilot(this.client, {
      channelId: process.env.STANDUP_CHANNEL_ID,
      timezone: process.env.STANDUP_TIMEZONE || "America/Los_Angeles",
    }) : null;
  }

  async run() {
    try {
      this.client.on("messageCreate", (message) => {
        this.standup?.handleMessage(message).catch(error => {
          console.error("Standup message failed:", error.message);
        });
      });
      this.client.once("ready", () => {
        console.log("Bot is ready!");
        if (this.channelId && this.responseChannelId) {
          this.scheduleQuestions().catch(error => console.error("Questions schedule failed:", error));
        }
        if (this.checkInChannelId) this.scheduleDailyCheckin();
        this.standup?.start();
        this.client.user.setPresence({
          activities: [{ name: "Tracking Check-ins", type: ActivityType.Watching }],
          status: "online",
        });
      });

      this.client.on("error", (error) => {
        console.error("Discord client error:", error);
      });

      await this.client.login(this.token);
    } catch (error) {
      console.error("Failed to start bot:", error);
      throw error;
    }
  }

  async scheduleQuestions() {
    const job = schedule.scheduleJob(
      {
        hour: 8,
        minute: 0,
        tz: "America/Los_Angeles",
        dayOfWeek: [1, 2, 3, 4, 5], // Monday through Friday
      },
      async () => {
        console.log(
          `Scheduled check-in for: ${new Date().toLocaleString("en-US", {
            timeZone: "America/Los_Angeles",
            weekday: "long",
            year: "numeric",
            month: "long",
            day: "numeric",
            hour: "2-digit",
            minute: "2-digit",
            timeZoneName: "short",
          })}`
        );

        let attempt = 1;
        const maxAttempts = this.retryAttempts;

        while (attempt <= maxAttempts) {
          try {
            const channel = await this.client.channels.fetch(this.channelId);
            if (!channel) {
              throw new Error(`Channel with ID ${this.channelId} not found.`);
            }

            const members = await channel.guild.members.fetch();
            const textChannel = await this.client.channels.fetch(
              this.responseChannelId
            );
            if (!textChannel) {
              throw new Error(
                `Response channel with ID ${this.responseChannelId} not found.`
              );
            }

            // Process members with rate limiting
            for (const member of members.values()) {
              if (member.user.bot) continue;

              await this.processUserQuestions(member, textChannel);
              // Add delay between members to avoid rate limiting
              await new Promise((resolve) => setTimeout(resolve, 1000));
            }
            break; // Success - exit the retry loop
          } catch (error) {
            console.error(
              `Error during scheduled job (Attempt ${attempt}):`,
              error
            );
            if (attempt === maxAttempts) {
              console.error("Max retry attempts reached. Giving up.");
              return;
            }
            attempt++;
            await new Promise((resolve) =>
              setTimeout(resolve, this.retryDelay)
            );
          }
        }
      }
    );

    if (job) {
      this.scheduledJobs.push(job);
      console.log("Questions schedule created successfully");
    } else {
      throw new Error("Failed to create questions schedule");
    }
  }

  async processUserQuestions(member, textChannel) {
    const responses = {};
    try {
      const dmChannel = await member.user.createDM();

      for (const question of this.questions) {
        try {
          await dmChannel.send(question);
          const collected = await dmChannel.awaitMessages({
            filter: (m) => m.author.id === member.user.id,
            max: 1,
            time: 3 * 60 * 60 * 1000, // 3 hour timeout
            errors: ["time"],
          });

          const response = collected.first();
          responses[question] = response ? response.content : "No response";
          // Clean up collected messages
          if (response) {
            await response.delete().catch(() => {});
          }
        } catch (error) {
          console.error(
            `Error processing question for ${member.user.tag}:`,
            error
          );
          responses[question] = "No response received";
        }
      }

      await textChannel.send({
        content: `Responses from ${member.user.tag}:`,
        embeds: [
          new EmbedBuilder()
            .setTitle("Weekly Check-in")
            .setDescription(
              Object.entries(responses)
                .map(([question, answer]) => `**${question}**\n${answer}`)
                .join("\n\n")
            )
            .setTimestamp(),
        ],
      });
    } catch (error) {
      console.error(`Cannot send DM to ${member.user.tag}:`, error);
      await textChannel.send(
        `Unable to collect responses from ${member.user.tag} - DMs may be disabled.`
      );
    }
  }

  async validateCheckInChannel() {
    try {
      const channel = await this.client.channels.fetch(this.checkInChannelId);
      if (!channel || !channel.isTextBased()) {
        throw new Error(`Invalid check-in channel: ${this.checkInChannelId}`);
      }
      return channel;
    } catch (error) {
      console.error("Check-in channel validation failed:", error);
      throw error;
    }
  }

  async sendCheckInMessage(channel, attempt = 1) {
    try {
      const message = await channel.send({
        content:
          "**Daily Check-in!** 👋 Please react to this message or say 'here' to indicate you're present and ready to code today!",
        embeds: [
          new EmbedBuilder()
            .setTitle("Daily Check-in")
            .setDescription('React with 👋 or type "here" to check in')
            .setTimestamp(),
        ],
      });
      console.log(`Check-in message sent successfully (Attempt ${attempt})`);
      return message;
    } catch (error) {
      console.error(
        `Failed to send check-in message (Attempt ${attempt}):`,
        error
      );
      if (attempt < this.retryAttempts) {
        console.log(`Retrying in ${this.retryDelay / 1000} seconds...`);
        await new Promise((resolve) => setTimeout(resolve, this.retryDelay));
        return this.sendCheckInMessage(channel, attempt + 1);
      }
      throw error;
    }
  }

  scheduleDailyCheckin() {
    const job = schedule.scheduleJob(
      { hour: 9, minute: 0, tz: "America/Los_Angeles" },
      async () => {
        try {
          const channel = await this.validateCheckInChannel();
          await this.sendCheckInMessage(channel);
        } catch (error) {
          console.error("Failed to schedule daily check-in:", error);
        }
      }
    );

    if (job) {
      this.scheduledJobs.push(job);
      // Add this console log to show next scheduled time
      console.log(
        `Daily check-in scheduled for ${job
          .nextInvocation()
          .toLocaleString("en-US", {
            timeZone: "America/Los_Angeles",
            weekday: "long",
            year: "numeric",
            month: "long",
            day: "numeric",
            hour: "2-digit",
            minute: "2-digit",
            timeZoneName: "short",
          })}`
      );
    } else {
      console.error("Failed to create check-in schedule");
    }
  }

  cleanup() {
    this.standup?.cleanup();
    this.scheduledJobs.forEach((job) => job.cancel());
    this.client.destroy();
  }
}

