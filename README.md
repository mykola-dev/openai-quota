# ⚡ OpenAI Quota for OpenCode

![OpenCode](https://img.shields.io/badge/OpenCode-2.2.3-808080?style=flat-square)
![TypeScript](https://img.shields.io/badge/TypeScript-3178C6?style=flat-square&logo=typescript&logoColor=white)
![5-hour quota](https://img.shields.io/badge/5h_quota-02dbf7?style=flat-square)
![7-day quota](https://img.shields.io/badge/7d_quota-f3f702?style=flat-square)

Your ChatGPT quota, right in the OpenCode footer. Remaining **5-hour & 7-day limits**, reset countdowns, and customizable colors — without leaving the terminal. ✨

![OpenAI quota in the OpenCode footer](screenshot.png)

## 🚀 Install

**1. Clone and install dependencies**

```sh
git clone https://github.com/mykola-dev/openai-quota.git
cd openai-quota
npm ci --ignore-scripts
```

**2. Add the checkout to your global `~/.config/opencode/opencode.json`**

Merge this entry with your existing plugins, using the **absolute path** to the cloned folder:

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": ["/absolute/path/to/openai-quota"]
}
```

On Windows, use forward slashes: `D:/dev/ai/openai-quota`.

**3. Run `/reload`, select an OpenAI model, and you're set. 🎉**

Requires OpenCode V2 (tested on **2.2.3**), an OpenAI **Sign in with ChatGPT** connection, and Node.js **26.4.0+** for the install command above. No separate API key needed.

## 🎨 Make it yours

Open the command palette → **OpenAI quota → Settings** to edit the template, hex/RGBA colors, or preview your layout. Settings are saved automatically. Use `/quota` to refresh manually.

Default template:

```text
{percent5h} {percent7d} | {reset5h} {reset7d}
```

Add any prefix or separators as plain text. Cyan is the 5-hour window; yellow is the 7-day window. 🩵 💛

> **Heads up:** some newer ChatGPT sign-ins don't expose numeric quota. The plugin shows `—`; `/quota` provides the ChatGPT usage-page URL. This is an unofficial plugin using an undocumented endpoint, so availability may change.
