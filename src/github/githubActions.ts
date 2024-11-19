import { graphql } from "@octokit/graphql";
import { Octokit } from "@octokit/rest";import { Attachment, Collection, Message, ActionRowBuilder, StringSelectMenuBuilder, ButtonBuilder, ButtonStyle } from "discord.js";
import { config } from "../config";
import { GitIssue, Thread } from "../interfaces";
import {
  ActionValue,
  Actions,
  Triggerer,
  getGithubUrl,
  logger,
} from "../logger";
import { store } from "../store";
import { createComment, createThread, getThreadChannel } from "../discord/discordActions";


let issueId = 0;

export const octokit = new Octokit({
  auth: config.GITHUB_ACCESS_TOKEN,
  baseUrl: "https://api.github.com",
});

const graphqlWithAuth = graphql.defaults({
  headers: {
    authorization: `token  ${process.env.GITHUB_ACCESS_TOKEN}`,
  },
});

export const repoCredentials = {
  owner: config.GITHUB_USERNAME,
  repo: config.GITHUB_REPOSITORY,
};

const info = (action: ActionValue, thread: Thread) =>
  logger.info(`githubActions | ${Triggerer.Discord} | ${action} | ${getGithubUrl(thread)}`);
const error = (action: ActionValue | string, thread?: Thread) =>
  logger.error(
    `githubActions | ${Triggerer.Discord} | ${action} ` +
    (thread ? `| ${getGithubUrl(thread)}` : ""),
  );

function attachmentsToMarkdown(attachments: Collection<string, Attachment>) {
  let md = "";
  attachments.forEach(({ url, name, contentType }) => {
    switch (contentType) {
      case "image/png":
      case "image/jpeg":
        md += `![${name}](${url} "${name}")`;
        break;
    }
  });
  return md;
}

function getIssueBody(params: Message) {
  const { guildId, channelId, id, content, author, attachments } = params;
  const { globalName, avatar } = author;

  return (
    `<kbd>[![${globalName}](https://cdn.discordapp.com/avatars/${author.id}/${avatar}.webp?size=40)](https://discord.com/channels/${guildId}/${channelId}/${id})</kbd> [${globalName}](https://discord.com/channels/${guildId}/${channelId}/${id})  \`BOT\`\n\n` +
    `${content}\n` +
    `${attachmentsToMarkdown(attachments)}\n`
  );
}

const regexForDiscordCredentials =
  /https:\/\/discord\.com\/channels\/(\d+)\/(\d+)\/(\d+)(?=\))/;
export function getDiscordInfoFromGithubBody(body: string) {
  const match = body.match(regexForDiscordCredentials);
  if (!match || match.length !== 4)
    return { channelId: undefined, id: undefined };
  const [, , channelId, id] = match;
  return { channelId, id };
}

function formatIssuesToThreads(issues: GitIssue[]): Thread[] {
  const res: Thread[] = [];
  issues.forEach(({ title, body, number, node_id, locked, state }) => {
    // Use a default value if the body is null or undefined
    const issueBody = body || "No Info";

    // Attempt to extract Discord info, but do not skip if missing
    const { id } = getDiscordInfoFromGithubBody(issueBody);

    res.push({
      id: id || `github-${node_id}`, // Use a fallback ID if Discord info is missing
      title,
      number,
      body: issueBody,
      node_id,
      locked,
      comments: [],
      appliedTags: [],
      archived: state === "closed",
    });
  });

  console.log(`Formatted ${res.length} issues into threads.`); // Log number of threads formatted
  return res;
}


async function update(issue_number: number, state: "open" | "closed") {
  try {
    await octokit.rest.issues.update({
      ...repoCredentials,
      issue_number,
      state,
    });
    return true;
  } catch (err) {
    return err;
  }
}

export async function closeIssue(thread: Thread) {
  const { number: issue_number } = thread;

  if (!issue_number) {
    error("Thread does not have an issue number", thread);
    return;
  }

  const response = await update(issue_number, "closed");
  if (response === true) info(Actions.Closed, thread);
  else if (response instanceof Error)
    error(`Failed to close issue: ${response.message}`, thread);
  else error("Failed to close issue due to an unknown error", thread);
}

export async function openIssue(thread: Thread) {
  const { number: issue_number } = thread;

  if (!issue_number) {
    error("Thread does not have an issue number", thread);
    return;
  }

  const response = await update(issue_number, "open");
  if (response === true) info(Actions.Reopened, thread);
  else if (response instanceof Error)
    error(`Failed to open issue: ${response.message}`, thread);
  else error("Failed to open issue due to an unknown error", thread);
}

export async function lockIssue(thread: Thread) {
  const { number: issue_number } = thread;
  if (!issue_number) {
    error("Thread does not have an issue number", thread);
    return;
  }

  try {
    await octokit.rest.issues.lock({
      ...repoCredentials,
      issue_number,
    });

    info(Actions.Locked, thread);
  } catch (err) {
    if (err instanceof Error) {
      error(`Failed to lock issue: ${err.message}`, thread);
    } else {
      error("Failed to lock issue due to an unknown error", thread);
    }
  }
}

export async function unlockIssue(thread: Thread) {
  const { number: issue_number } = thread;
  if (!issue_number) {
    error("Thread does not have an issue number", thread);
    return;
  }

  try {
    await octokit.rest.issues.unlock({
      ...repoCredentials,
      issue_number,
    });

    info(Actions.Unlocked, thread);
  } catch (err) {
    if (err instanceof Error) {
      error(`Failed to unlock issue: ${err.message}`, thread);
    } else {
      error("Failed to unlock issue due to an unknown error", thread);
    }
  }
}

export async function createIssue(thread: Thread, params: Message) {
  const { title, appliedTags, number } = thread;

  if (number) {
    error("Thread already has an issue number", thread);
    return;
  }

  try {
    const labels = appliedTags?.map(
      (id) => store.availableTags.find((item) => item.id === id)?.name || "",
    );

    const body = getIssueBody(params);
    const response = await octokit.rest.issues.create({
      ...repoCredentials,
      labels,
      title,
      body,
    });

    if (response && response.data) {
      thread.node_id = response.data.node_id;
      thread.body = response.data.body!;
      thread.number = response.data.number;

      const issueUrl = `https://github.com/${config.GITHUB_USERNAME}/${config.GITHUB_REPOSITORY}/issues/${thread.number}`;

      const { channel } = await getThreadChannel(thread.node_id);
      if (!channel) return;

      const users = await GetUsers();

      // Add a StringSelectMenu for selecting a developer (dropdown)
      const assigneeSelect = new StringSelectMenuBuilder()
        .setCustomId("select_developer")
        .setPlaceholder("Select a developer to assign")
        .addOptions(users);

      // Add a confirm button
      const confirmButton = new ButtonBuilder()
        .setCustomId("confirm_developer_assignment")
        .setLabel("Confirm")
        .setStyle(ButtonStyle.Primary);

      // Action rows to hold the dropdown and button
      const assigneeRow = new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(assigneeSelect);
      const buttonRow = new ActionRowBuilder<ButtonBuilder>().addComponents(confirmButton);

      issueId = thread.number;

      // Send the message with the dropdown and confirm button
      await channel.send({
        content: `Issue #${thread.number} has been created: ${issueUrl}\nPlease assign a developer.`,
        components: [assigneeRow, buttonRow],
      });

      info(Actions.Created, thread);
    } else {
      error("Failed to create issue - No response data", thread);
    }
  } catch (err) {
    if (err instanceof Error) {
      error(`Failed to create issue: ${err.message}`, thread);
    } else {
      error("Failed to create issue due to an unknown error", thread);
    }
  }
}

export async function createIssueComment(thread: Thread, params: Message) {
  const body = getIssueBody(params);
  const { number: issue_number } = thread;

  if (!issue_number) {
    error("Thread does not have an issue number", thread);
    return;
  }

  try {
    const response = await octokit.rest.issues.createComment({
      ...repoCredentials,
      issue_number: thread.number!,
      body,
    });
    if (response && response.data) {
      const git_id = response.data.id;
      const id = params.id;
      thread.comments.push({ id, git_id });
      info(Actions.Commented, thread);
    } else {
      error("Failed to create comment - No response data", thread);
    }
  } catch (err) {
    if (err instanceof Error) {
      error(`Failed to create comment: ${err.message}`, thread);
    } else {
      error("Failed to create comment due to an unknown error", thread);
    }
  }
}

export async function deleteIssue(thread: Thread) {
  const { node_id } = thread;
  if (!node_id) {
    error("Thread does not have a node ID", thread);
    return;
  }

  try {
    await graphqlWithAuth(
      `mutation {deleteIssue(input: {issueId: "${node_id}"}) {clientMutationId}}`,
    );
    info(Actions.Deleted, thread);
  } catch (err) {
    if (err instanceof Error) {
      error(`Error deleting issue: ${err.message}`, thread);
    } else {
      error("Error deleting issue due to an unknown error", thread);
    }
  }
}

export async function deleteComment(thread: Thread, comment_id: number) {
  try {
    await octokit.rest.issues.deleteComment({
      ...repoCredentials,
      comment_id,
    });
    info(Actions.DeletedComment, thread);
  } catch (err) {
    if (err instanceof Error) {
      error(`Failed to delete comment: ${err.message}`, thread);
    } else {
      error("Failed to delete comment due to an unknown error", thread);
    }
  }
}

export async function getIssues() {
  try {
    const response = await octokit.rest.issues.listForRepo({
      ...repoCredentials,
      state: "all",
    });

    if (!response || !response.data) {
      error("Failed to get issues - No response data");
      return [];
    }

    console.log(`Fetched ${response.data.length} issues from GitHub.`); // Log number of issues fetched

    await fillCommentsData(); // Wait for comments data to be filled

    const threads = formatIssuesToThreads(response.data as GitIssue[]);
    console.log(`Formatted ${threads.length} issues into threads.`); // Log number of threads formatted

    return threads;
  } catch (err) {
    if (err instanceof Error) {
      error(`Failed to get issues: ${err.message}`);
    } else {
      error("Failed to get issues due to an unknown error");
    }
    return [];
  }
}

export async function GetUsers() {
  const { data: collaborators } = await octokit.rest.repos.listCollaborators({
    ...repoCredentials,
  });
  
  const assigneeOptions = collaborators.map((user) => ({
    label: user.login,  // GitHub username
    value: user.login,  // You can use the username for assignment
  }));

  console.log("Users :",assigneeOptions);

  return assigneeOptions;
}

// Fetch repository projects (v2)
export async function getRepositoryProjects(owner: string, repo: string) {

  owner = repoCredentials.owner;
  repo = repoCredentials.repo;

  const query = `
    query ($owner: String!, $repo: String!) {
      repository(owner: $owner, name: $repo) {
        projectsV2(first: 10) {
          nodes {
            id
            title
          }
        }
      }
    }
  `;

  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result: any = await graphqlWithAuth(query,  { owner, repo });

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const projectOptions = result.repository.projectsV2.nodes.map((project: any) => ({
      label: project.title,
      value: project.id,
    }));

    console.log("Repository Projects v2: ", projectOptions);
    return projectOptions;
  } catch (error) {
    console.error("Error fetching repository projects:", error);
  }
}

async function fillCommentsData() {
  try {
    const response = await octokit.rest.issues.listCommentsForRepo({
      ...repoCredentials,
    });

    if (response && response.data) {
      response.data.forEach((comment) => {
        const { channelId, id } = getDiscordInfoFromGithubBody(comment.body!);
        if (!channelId || !id) return;

        const thread = store.threads.find((i) => i.id === channelId);
        thread?.comments.push({ id, git_id: comment.id });
      });
    } else {
      error("Failed to load comments - No response data");
    }
  } catch (err) {
    if (err instanceof Error) {
      error(`Failed to load comments: ${err.message}`);
    } else {
      error("Failed to load comments due to an unknown error");
    }
  }
}

export async function syncIssuesToDiscord() {
  const issues = await getIssues();

  const projectIds = getRepositoryProjects("a","b");

  console.log("projects: ", projectIds);

  // eslint-disable-next-line @typescript-eslint/no-unused-vars, no-unused-vars
  const users = await GetUsers();

  issues.forEach((thread) => {
    // Check if the thread already exists in the store
    const existingThread = store.threads.find((t) => t.node_id === thread.node_id);
    if (existingThread) {
      console.warn(`Skipping issue #${thread.number} as it already has a corresponding Discord thread.`);
      return;
    }

    if (!thread.body || !thread.node_id || !thread.number) {
      console.warn(`Skipping issue #${thread.number} due to missing data.`);
      return;
    }

    console.log(`Creating thread for issue #${thread.number}.`); // Log thread creation

    createThread({
      body: thread.body,
      login: "GitHub", // Assuming a default login name for existing issues
      title: thread.title,
      appliedTags: thread.appliedTags,
      node_id: thread.node_id,
      number: thread.number,
    });
  });
}

export async function syncCommentsToDiscord() {
  const issues = await getIssues(); // Fetch all issues

  for (const issue of issues) {
    const { number, node_id } = issue;

    if (!number || !node_id) {
      console.warn("Skipping issue due to missing data.");
      continue;
    }

    try {
      const commentsResponse = await octokit.rest.issues.listComments({
        ...repoCredentials,
        issue_number: number,
      });

      if (!commentsResponse || !commentsResponse.data) {
        console.warn(`No comments found for issue #${number}.`);
        continue;
      }

      for (const comment of commentsResponse.data) {
        const { body, user, id } = comment;
        const { login, avatar_url } = user || {};

        // Check if the comment has already been synced
        const thread = store.threads.find((t) => t.node_id === node_id);
        if (!thread || thread.comments.some((c) => c.git_id === id)) {
          continue;
        }

        if (!login || !avatar_url || !body) {
          console.warn(`Skipping comment #${id} due to missing data.`);
          continue;
        }

        // Post the comment to Discord
        await createComment({
          git_id: id,
          body,
          login,
          avatar_url,
          node_id,
        });

        // Add the comment to the thread's comments list
        thread.comments.push({ id: `discord-${id}`, git_id: id });
      }
    } catch (error) {
      if (error instanceof Error) {
        console.error(`Failed to sync comments for issue #${number}: ${error.message}`);
      } else {
        console.error(`Failed to sync comments for issue #${number}: Unknown error.`);
      }
    }
  }
}

// Function to assign a developer to a GitHub issue
export async function assignIssue(issueNumber: number, assignee: string) {

  issueNumber = issueId;

  issueId = 0;

  console.log(issueNumber, assignee);
  try {
    await octokit.request("POST /repos/{owner}/{repo}/issues/{issue_number}/assignees", {
      owner: repoCredentials.owner, // GitHub username of the repository owner
      repo: repoCredentials.repo, // Name of the repository
      issue_number: issueNumber,
      assignees: [assignee], // Selected developer's username
      headers: {
        "X-GitHub-Api-Version": "2022-11-28", // Optional: GitHub API version header
                  },
            });
            console.log(`Assigned ${assignee} to issue #${issueNumber}`);
      } catch (error) {
            if (error instanceof Error) {
                  console.error(`Error assigning ${assignee} to issue #${issueNumber}:`, error.message);
                  throw new Error(`Error assigning developer: ${error.message}`);
            } else {
                  console.error(`Error assigning ${assignee} to issue #${issueNumber}: Unknown error.`);
                  throw new Error("Error assigning developer: Unknown error.");
            }
      }
}