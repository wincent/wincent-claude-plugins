# wincent-agent-plugins

Agent[^agent] plugins, skills, and extensions from Greg Hurrell.

[^agent]: Originally developed for [Claude](https://claude.com/product/claude-code) but usable with other agent(s) such as [Pi](https://pi.dev/) as well. For anything that can't directly consume the plug-ins as-is, any agent worth its salt should be able to port them into a suitable format if you point it at this repo and ask it to convert things for you.

## Plugins

### Claude

Plugins live under [`claude/`](./claude):

- [atlassian](./claude/atlassian): Jira and Confluence access via the Atlassian CLI (`acli`).
- [git](./claude/git): Git version control skills.
- [jj](./claude/jj): Jujutsu version control skills.
- [meme](./claude/meme): Generate meme images using popular templates via the imgflip API.
- [pr](./claude/pr): GitHub pull request creation and review.
- [session](./claude/session): Claude session management utilities (e.g. export a Claude session to a GitLab snippet).
- [shannon](./claude/shannon): Neovim integration via RPC for annotated code review, walkthroughs, and navigation.

### Pi

#### Prompt templates

Pi prompt templates live under [`pi/prompts`](./pi/prompts/):

- [pi-update](./pi/prompts/pi-update.md) (Pi-only): check for Pi updates, checking against installed skills, extensions, and prompts for compatibility issues.

#### Skills

Pi skills live under [`pi/skills`](./pi/skills/):

- [atlassian-confluence](./pi/skills/atlassian-confluence)
- [atlassian-jira](./pi/skills/atlassian-jira)
- [datadog-mcp](./pi/skills/datadog-mcp) (Pi-only)
- [google-workspace-mcp](./pi/skills/google-workspace-mcp) (Pi-only)
- [git-commit](./pi/skills/git-commit)
- [gitlab-snippet-create](./pi/skills/gitlab-snippet-create) (Pi-only)
- [jj-commit](./pi/skills/jj-commit)
- [jj-version-control](./pi/skills/jj-version-control)
- [meme-create](./pi/skills/meme-create)
- [neovim](./pi/skills/neovim) (corresponds to "shannon" Claude skill, above)
- [pr-create](./pi/skills/pr-create)
- [pr-review](./pi/skills/pr-review)
- [slack-mcp](./pi/skills/slack-mcp) (Pi-only)
- [subagent](./pi/skills/subagent) (Pi-only)

Many of these are symlinks pointing to the corresponding Claude skills (all the skills have been written to be as agent-agnostic as possible). Some are specific to Pi (ie. the ones marked with "Pi-only"). Note that Pi skills need globally unique names, unlike Claude skills which are namespaced under plugin prefixes.

#### Extensions

Pi extensions live under [`pi/extensions`](./pi/extensions/):

- [datadog-mcp](./pi/extensions/datadog-mcp.ts)
- [edit-answer](./pi/extensions/edit-answer.ts)
- [google-workspace-mcp](./pi/extensions/google-workspace-mcp.ts)
- [jj-guard](./pi/extensions/jj-guard.ts)
- [model-info](./pi/extensions/model-info.ts)
- [slack-mcp](./pi/extensions/slack-mcp.ts)
- [subagent](./pi/extensions/subagent)
- [total-cost](./pi/extensions/total-cost.ts)

## Claude setup

Add the marketplace:

```bash
claude plugin marketplace add wincent/wincent-agent-plugins
```

Then install any plugin:

```bash
claude plugin install atlassian
claude plugin install git
claude plugin install jj
claude plugin install meme
claude plugin install pr
claude plugin install session
claude plugin install shannon
```

## Pi setup

If you install the Claude marketplace, you can configure Pi to look for skills, prompt templates, and extensions under `~/.claude/plugins/marketplaces/wincent-agent-plugins/` in your `~/.pi/agent/settings.json`:

```json
{
  "extensions": [
    "~/.claude/plugins/marketplaces/wincent-agent-plugins/pi/extensions"
  ],
  "skills": [
    "~/.claude/plugins/marketplaces/wincent-agent-plugins/pi/skills"
  ],
  "prompts": [
    "~/.claude/plugins/marketplaces/wincent-agent-plugins/pi/prompts"
  ]
}
```
