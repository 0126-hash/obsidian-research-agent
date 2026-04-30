# Research Agent for Obsidian

Research Agent is a conversational research plugin for Obsidian. It helps turn a research question into a guided workflow with chat, task progress, evidence notes, and Markdown deliverables.

The plugin connects to Deep Research Cloud at `https://research.obclaude.com` for account authentication, online search, fact checking, and long-running research tasks.

## Features

- Ask research questions in a chat-style panel.
- Use the current note or selected text only when you explicitly choose to send it.
- Review research task progress before accepting a full Deep Research run.
- Inspect evidence and results separately from the conversation.
- Export completed research results back into your local vault as Markdown.

## Privacy and network use

Research Agent is a cloud-connected plugin. It sends requests to `https://research.obclaude.com` when you use the agent, Fact Guard, or Deep Research features.

By default, the plugin does not send the full current note. Current note content or selected text is sent only after you use the corresponding controls, such as `Use current note` or a selected-text follow-up.

Do not send sensitive notes or private data unless you intend to process them with the cloud service.

## Installation

After the plugin is accepted into the Obsidian community plugin directory, install it from `Settings -> Community plugins -> Browse` by searching for `Research Agent`.

For beta testing before marketplace approval, install with BRAT:

1. In Obsidian, install and enable `BRAT` from Community plugins.
2. Run `BRAT: Add a beta plugin for testing`.
3. Paste this repository URL:

```text
https://github.com/0126-hash/obsidian-research-agent
```

4. Enable `Research Agent` in Community plugins.

## Sign in

After enabling the plugin, open `Settings -> Community plugins -> Research Agent`.
Fill in the cloud service URL, account email, and password provided to you.
Existing users can sign in directly; new users need an invite code.

## Release files

Each GitHub release includes the files Obsidian downloads:

- `main.js`
- `manifest.json`
- `styles.css`

The release tag must match the version in `manifest.json`.
