import {
  AnyThreadChannel,
  Client,
  DMChannel,
  ForumChannel,
  Interaction,
  Message,
  NonThreadGuildBasedChannel,
  PartialMessage,
  ThreadChannel,
} from "discord.js";
import { config } from "../config";
import {
  assignIssue,
  closeIssue,
  createIssue,
  createIssueComment,
  deleteComment,
  deleteIssue,
  getIssues,
  lockIssue,
  openIssue,
  syncCommentsToDiscord,
  syncIssuesToDiscord,
  unlockIssue,
} from "../github/githubActions";
import { logger } from "../logger";
import { store } from "../store";
import { Thread } from "../interfaces";

export async function handleClientReady(client: Client) {
  logger.info(`Logged in as ${client.user?.tag}!`);

  store.threads = await getIssues();

  // Fetch cache for closed threads
  const threadPromises = store.threads.map(async (thread) => {
    const cachedChannel = client.channels.cache.get(thread.id) as
      | ThreadChannel
      | undefined;
    if (cachedChannel) {
      cachedChannel.messages.cache.forEach((message) => message.id);
      return thread; // Returning thread as valid
    } else {
      try {
        const channel = (await client.channels.fetch(
          thread.id,
        )) as ThreadChannel;
        channel.messages.cache.forEach((message) => message.id);
        return thread; // Returning thread as valid
      } catch (error) {
        return; // Marking thread as invalid
      }
    }
  });
  const threadPromisesResults = await Promise.all(threadPromises);
  store.threads = threadPromisesResults.filter(
    (thread) => thread !== undefined,
  ) as Thread[];

  logger.info(`Issues loaded : ${store.threads.length}`);

  client.channels.fetch(config.DISCORD_CHANNEL_ID).then((params) => {
    store.availableTags = (params as ForumChannel).availableTags;
  });

  // Call syncIssuesToDiscord after the client is ready
  await syncIssuesToDiscord();

    // Call syncCommentsToDiscord to synchronize comments
    await syncCommentsToDiscord();
}

export async function handleThreadCreate(params: AnyThreadChannel) {
  if (params.parentId !== config.DISCORD_CHANNEL_ID) return;

  const { id, name, appliedTags } = params;

  store.threads.push({
    id,
    appliedTags,
    title: name,
    archived: false,
    locked: false,
    comments: [],
  });
}

export async function handleChannelUpdate(
  params: DMChannel | NonThreadGuildBasedChannel,
) {
  if (params.id !== config.DISCORD_CHANNEL_ID) return;

  if (params.type === 15) {
    store.availableTags = params.availableTags;
  }
}

export async function handleThreadUpdate(params: AnyThreadChannel) {
  if (params.parentId !== config.DISCORD_CHANNEL_ID) return;

  const { id, archived, locked } = params.members.thread;
  const thread = store.threads.find((item) => item.id === id);
  if (!thread) return;

  if (thread.locked !== locked && !thread.lockLocking) {
    if (thread.archived) {
      thread.lockArchiving = true;
    }
    thread.locked = locked;
    locked ? lockIssue(thread) : unlockIssue(thread);
  }
  if (thread.archived !== archived) {
    setTimeout(() => {
      // timeout for fixing discord archived post locking
      if (thread.lockArchiving) {
        if (archived) {
          thread.lockArchiving = false;
        }
        thread.lockLocking = false;
        return;
      }
      thread.archived = archived;
      archived ? closeIssue(thread) : openIssue(thread);
    }, 500);
  }
}

export async function handleMessageCreate(params: Message) {
  const { channelId, author } = params;

  if (author.bot) return;

  const thread = store.threads.find((thread) => thread.id === channelId);

  if (!thread) return;

  if (!thread.body) {
    createIssue(thread, params);
  } else {
    createIssueComment(thread, params);
  }
}

export async function handleMessageDelete(params: Message | PartialMessage) {
  const { channelId, id } = params;
  const thread = store.threads.find((i) => i.id === channelId);
  if (!thread) return;

  const commentIndex = thread.comments.findIndex((i) => i.id === id);
  if (commentIndex === -1) return;

  const comment = thread.comments.splice(commentIndex, 1)[0];
  deleteComment(thread, comment.git_id);
}

export async function handleThreadDelete(params: AnyThreadChannel) {
  if (params.parentId !== config.DISCORD_CHANNEL_ID) return;

  const thread = store.threads.find((item) => item.id === params.id);
  if (!thread) return;

  deleteIssue(thread);
}

// Temporary in-memory store to map interaction/user to selected developers
const developerSelectionStore: Record<string, string> = {};
export async function handleInteraction(interaction: Interaction) {
  // Handle dropdown selection
  if (interaction.isStringSelectMenu() && interaction.customId === "select_developer") {
    const selectedDeveloper = interaction.values[0]; // The selected developer's username

    // Store the selected developer, keyed by user or interaction ID
    developerSelectionStore[interaction.user.id] = selectedDeveloper;

    await interaction.reply({ content: `Selected developer: ${selectedDeveloper}`, ephemeral: true });
  }

  // Handle confirm button click
  if (interaction.isButton() && interaction.customId === "confirm_developer_assignment") {
    const selectedDeveloper = developerSelectionStore[interaction.user.id]; // Retrieve from store

    if (!selectedDeveloper) {
      await interaction.reply({ content: "Please select a developer before confirming.", ephemeral: true });
      return;
    }

    const issueNumber = 123; // You should retrieve the issue number dynamically (e.g., from thread context)
    
    try {
      // Assign the selected developer to the issue via GitHub API
      await assignIssue(issueNumber, selectedDeveloper);

      await interaction.reply({ content: `Developer ${selectedDeveloper} assigned to the issue successfully!`, ephemeral: true });

      // Clear the stored selection after assigning
      delete developerSelectionStore[interaction.user.id];
    } catch (error) {
      console.error("Failed to assign developer:", error);
      await interaction.reply({ content: "Failed to assign developer.", ephemeral: true });
    }
  }
};
