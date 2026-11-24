#!/usr/bin/env bun
import { select } from "@inquirer/prompts";
import { $ } from "bun";

// --- Load .env from the script's own directory ---

const envFile = Bun.file(`${import.meta.dir}/.env`);
if (await envFile.exists()) {
  const text = await envFile.text();
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const idx = trimmed.indexOf("=");
    if (idx === -1) continue;
    const key = trimmed.slice(0, idx).trim();
    const value = trimmed.slice(idx + 1).trim().replace(/^["']|["']$/g, "");
    process.env[key] ??= value; // don't override vars already set in environment
  }
}

// --- Config ---

const JIRA_BASE_URL = process.env.JIRA_BASE_URL!;
const JIRA_EMAIL = process.env.JIRA_EMAIL!;
const JIRA_API_TOKEN = process.env.JIRA_API_TOKEN!;
const JIRA_EXTRA_FIELDS: string[] = process.env.JIRA_EXTRA_FIELDS
  ? process.env.JIRA_EXTRA_FIELDS.split(",").map((f) => f.trim()).filter(Boolean)
  : [];
const MAIN_BRANCH = process.env.JIRA_MAIN_BRANCH ?? "main";

if (!JIRA_BASE_URL || !JIRA_EMAIL || !JIRA_API_TOKEN) {
  console.error("Missing JIRA_BASE_URL, JIRA_EMAIL, or JIRA_API_TOKEN in .env");
  process.exit(1);
}

const headers = {
  Authorization: `Basic ${btoa(`${JIRA_EMAIL}:${JIRA_API_TOKEN}`)}`,
  Accept: "application/json",
};

// --- Types ---

interface JiraIssue {
  key: string;
  fields: {
    summary: string;
    description: unknown;
    [acField: string]: unknown;
  };
}

interface JiraSearchResponse {
  issues: JiraIssue[];
  total: number;
}

// --- Jira helpers ---

async function fetchFieldRegistry(): Promise<Record<string, string>> {
  const res = await fetch(`${JIRA_BASE_URL}/rest/api/3/field`, { headers });
  if (!res.ok) throw new Error(`Jira fields API error: ${res.status}`);
  const fields = (await res.json()) as { id: string; name: string }[];
  return Object.fromEntries(fields.map((f) => [f.id, f.name]));
}

async function discoverFields() {
  console.log("Fetching one ticket with all fields to discover custom field IDs…\n");
  const registry = await fetchFieldRegistry();

  const res = await fetch(`${JIRA_BASE_URL}/rest/api/3/search/jql`, {
    method: "POST",
    headers: { ...headers, "Content-Type": "application/json" },
    body: JSON.stringify({
      jql: "assignee = currentUser() AND statusCategory != Done ORDER BY updated DESC",
      fields: ["*all"],
      maxResults: 1,
    }),
  });
  if (!res.ok) throw new Error(`Jira API error: ${res.status}`);
  const data = (await res.json()) as { issues: { key: string; fields: Record<string, unknown> }[] };
  const issue = data.issues[0];
  if (!issue) { console.log("No tickets found."); return; }

  console.log(`Sample ticket: ${issue.key}\n`);
  console.log("Non-null custom fields:\n");
  for (const [id, value] of Object.entries(issue.fields)) {
    if (!id.startsWith("customfield_") || value === null || value === undefined) continue;
    const name = registry[id] ?? "(unknown)";
    const preview =
      typeof value === "object" ? JSON.stringify(value).slice(0, 80) + "…" : String(value);
    console.log(`  ${id}  "${name}"\n    ${preview}\n`);
  }
  console.log(`\nSet JIRA_AC_FIELD=<id> in your .env to use the correct field.`);
}

async function fetchMyTickets(): Promise<{ issues: JiraIssue[]; fieldNames: Record<string, string> }> {
  const url = `${JIRA_BASE_URL}/rest/api/3/search/jql`;

  const [res, fieldNames] = await Promise.all([
    fetch(url, {
      method: "POST",
      headers: { ...headers, "Content-Type": "application/json" },
      body: JSON.stringify({
        jql: "assignee = currentUser() AND statusCategory != Done ORDER BY updated DESC",
        fields: ["summary", "description", ...JIRA_EXTRA_FIELDS],
        maxResults: 50,
      }),
    }),
    JIRA_EXTRA_FIELDS.length > 0 ? fetchFieldRegistry() : Promise.resolve({} as Record<string, string>),
  ]);

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Jira API error: ${res.status} ${res.statusText}\n${body}`);
  }

  const data = (await res.json()) as JiraSearchResponse;
  return { issues: data.issues, fieldNames };
}

/**
 * Convert Atlassian Document Format (ADF) to plain markdown-ish text.
 */
function adfToMarkdown(node: any, depth = 0, listIndex?: number): string {
  if (!node) return "_No description provided._";
  if (typeof node === "string") return node;

  let text = "";

  switch (node.type) {
    case "doc":
      text = (node.content ?? []).map((c: any) => adfToMarkdown(c, depth)).join("\n\n");
      break;
    case "paragraph":
      text = (node.content ?? []).map((c: any) => adfToMarkdown(c, depth)).join("");
      break;
    case "text": {
      let t = node.text ?? "";
      for (const mark of node.marks ?? []) {
        if (mark.type === "strong") t = `**${t}**`;
        if (mark.type === "em") t = `_${t}_`;
        if (mark.type === "code") t = `\`${t}\``;
        if (mark.type === "link") t = `[${t}](${mark.attrs?.href ?? ""})`;
      }
      text = t;
      break;
    }
    case "heading": {
      const level = node.attrs?.level ?? 1;
      const prefix = "#".repeat(level);
      text = `${prefix} ${(node.content ?? []).map((c: any) => adfToMarkdown(c, depth)).join("")}`;
      break;
    }
    case "bulletList":
      text = (node.content ?? []).map((c: any) => adfToMarkdown(c, depth)).join("\n");
      break;
    case "orderedList":
      text = (node.content ?? [])
        .map((c: any, i: number) => adfToMarkdown(c, depth, i + 1))
        .join("\n");
      break;
    case "listItem": {
      const indent = "  ".repeat(depth);
      const bullet = listIndex != null ? `${listIndex}.` : "-";
      const inner = (node.content ?? []).map((c: any) => adfToMarkdown(c, depth + 1)).join("\n");
      text = `${indent}${bullet} ${inner}`;
      break;
    }
    case "codeBlock": {
      const lang = node.attrs?.language ?? "";
      const code = (node.content ?? []).map((c: any) => adfToMarkdown(c, depth)).join("");
      text = `\`\`\`${lang}\n${code}\n\`\`\``;
      break;
    }
    case "blockquote":
      text = (node.content ?? [])
        .map((c: any) => "> " + adfToMarkdown(c, depth))
        .join("\n");
      break;
    case "rule":
      text = "---";
      break;
    case "hardBreak":
      text = "\n";
      break;
    case "mention":
      text = `@${node.attrs?.text ?? "unknown"}`;
      break;
    case "inlineCard":
      text = node.attrs?.url ?? "";
      break;
    default:
      // Recurse into unknown nodes
      if (node.content) {
        text = (node.content as any[]).map((c) => adfToMarkdown(c, depth)).join("");
      }
      break;
  }

  return text;
}

// --- Branch name helper ---

function toBranchName(key: string, summary: string): string {
  return (
    key +
    "-" +
    summary
      .toLowerCase()
      .replace(/[^a-z0-9_\-\s]/g, "") // remove special chars (keep underscores, hyphens)
      .replace(/\s+/g, "-")           // spaces to hyphens
      .replace(/-+/g, "-")            // collapse multiple hyphens
      .replace(/-$/, "")              // trim trailing hyphen
  ).toLowerCase();
}

// --- Main ---

async function main() {
  if (process.argv.includes("--discover-fields")) {
    await discoverFields();
    return;
  }

  console.log("Fetching Jira tickets assigned to you…");
  const { issues, fieldNames } = await fetchMyTickets();

  if (issues.length === 0) {
    console.log("No open tickets assigned to you.");
    return;
  }

  console.log(`Found ${issues.length} ticket(s).\n`);

  const chosen = await select({
    message: "Select a ticket to start working on:",
    choices: issues.map((issue) => ({
      name: `${issue.key}  ${issue.fields.summary}`,
      value: issue,
    })),
  });

  const branchName = toBranchName(chosen.key, chosen.fields.summary);

  console.log(`\nBranch: ${branchName}`);

  // Checkout new branch from main (runs in the user's pwd, not the script dir)
  if (process.argv.includes("--branch")) {
    try {
      await $`git checkout ${MAIN_BRANCH}`.quiet();
      await $`git pull --ff-only`.quiet();
    } catch {
      console.error("Warning: could not switch to main or pull. Continuing anyway…");
    }

    try {
      await $`git checkout -b ${branchName}`;
      console.log(`Checked out new branch: ${branchName}`);
    } catch (e: any) {
      console.error(`Failed to create branch: ${e.message}`);
      process.exit(1);
    }
  }

  // Write ticket description to .md file
  const description = adfToMarkdown(chosen.fields.description);
  const extraSections = JIRA_EXTRA_FIELDS
    .filter((field) => chosen.fields[field] != null)
    .map((field) => {
      const heading = fieldNames[field] ?? field;
      return `\n\n## ${heading}\n\n${adfToMarkdown(chosen.fields[field])}`;
    })
    .join("");
  const mdContent = `# ${chosen.key}: ${chosen.fields.summary}\n\n${description}${extraSections}`;
  const mdFileName = `${branchName}.md`;

  await Bun.write(mdFileName, mdContent);
  console.log(`Created ${mdFileName}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
