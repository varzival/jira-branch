# jira-branch

To install dependencies:

```bash
bun install
```

To run:

```bash
bun run index.ts
```

This project was created using `bun init` in bun v1.3.2. [Bun](https://bun.com) is a fast all-in-one JavaScript runtime.

Put it in the `.local/bin` to run it from anywhere:

```
ln -sf ./main.ts $HOME/.local/bin/jira-branch
echo 'export PATH="$HOME/.local/bin:$PATH"' >> ~/.zshrc
```

## Configuration

Copy `.env.example` to `.env` and fill in your credentials:

| Variable | Required | Description |
|---|---|---|
| `JIRA_BASE_URL` | ✅ | Your Jira instance URL, e.g. `https://your-domain.atlassian.net` |
| `JIRA_EMAIL` | ✅ | Your Atlassian account email |
| `JIRA_API_TOKEN` | ✅ | API token from [id.atlassian.com/manage-profile/security/api-tokens](https://id.atlassian.com/manage-profile/security/api-tokens) |
| `JIRA_MAIN_BRANCH` | — | Branch to check out from before creating a new branch (default: `main`) |
| `JIRA_EXTRA_FIELDS` | — | Comma-separated list of custom field IDs to append to the generated `.md` file |

## Discovering custom field IDs

Jira stores fields like "Acceptance Criteria" under opaque IDs (e.g. `customfield_10034`) that vary per instance. To find the right IDs, run:

```
jira-branch --discover-fields
```

This fetches your most recently updated open ticket with all fields and prints every non-null custom field alongside its human-readable name and a value preview:

```
Sample ticket: PROD-3715

Non-null custom fields:

  customfield_10014  "Acceptance Criteria"
    {"type":"doc","version":1,"content":[...]}…

  customfield_10016  "Story Points"
    5
```

Once you find the fields you want, add them to `.env`:

```
JIRA_EXTRA_FIELDS=customfield_10014,customfield_10016
```

Each field will be appended as its own `##` section (using its human-readable name) in the generated `.md` file.