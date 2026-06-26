---
description: List the Gainable apps in the current account
argument-hint: [optional -q <text> to filter by project name]
allowed-tools: Bash(gaia apps:*), Bash(gaia:*)
---

List the apps in the user's Gainable account by running:

`gaia apps list $ARGUMENTS`

The `$ARGUMENTS` slot lets the user pass `-q <text>` to filter (e.g. `/gainable:apps -q portfolio`). Default (no args) returns the full list.

Surface the results as a readable summary — project name, appName, last accessed time. Don't dump raw JSON unless the user asks.
