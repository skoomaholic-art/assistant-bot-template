# Instagram Manager · Telegram bot & Mini App

An AI assistant for running an Instagram account about movies and TV, controlled entirely from Telegram.

- The AI writes posts, carousels and Reels from fresh film/TV news (or your own topics)
- You approve the **text** and then the **final** right in Telegram — nothing is published without both approvals
- A cover designer (Cover Studio) with AI image prompts, your own photos and videos
- Live Reels: background motion, 2.5D depth, animated text, transitions and music
- Analytics, a "Viral Lab" that compares formats/genres, and an AI editor that learns from your edits

This repository is **one of two halves**:

| Repository | What it is | Where it runs |
|---|---|---|
| **assistant-bot-template** (this one) | Telegram bot, Mini App, Cover Studio, AI drafts | Vercel (free Hobby plan) |
| [insta-engine-template](https://github.com/skoomaholic-art/insta-engine-template) | Data store + the "robot" that renders images/video and publishes | GitHub Actions |

Everything runs on free tiers: Vercel Hobby, GitHub, Groq (AI), the official Instagram API. No coding required, just copy/paste.

> A step-by-step illustrated guide in Russian is in [`guide/setup-guide.pdf`](guide/setup-guide.pdf).

---

## How it works

```
News / your topic ─► AI writes a draft ─► card in Telegram ─► "Text OK"
     ─► robot (GitHub Actions) renders slides/Reels in Cover Studio ─► final in Telegram ─► "Publish"
     ─► Instagram API ─► metrics after 24 h / 72 h / 7 days ─► the AI adjusts its strategy
```

The bot talks **only to its owner** (your Telegram ID). Anyone else who presses `/start` gets a short greeting and the setup guide, nothing more.

---

## Setup (about 1–1.5 hours, both repositories)

Write every key you get into a private note — you will need them in later steps. Never paste keys into chats, issues or screenshots.

### 1. Create the Telegram bot
1. Open [@BotFather](https://t.me/BotFather) → `/newbot`
2. Choose a display name and a username ending in `bot` (e.g. `mycinema_manager_bot`)
3. Save the token `1234567890:AA…` → this is **`TG_BOT_TOKEN`**
4. Get your numeric Telegram ID from [@userinfobot](https://t.me/userinfobot) → **`TG_OWNER_CHAT_ID`**

Optional polish in BotFather: `/setuserpic` (avatar), `/setdescription`, `/setabouttext`, `/setjoingroups → Disable`.

### 2. Copy both templates (as private repositories)
1. On this page click **Use this template → Create a new repository**, name it `assistant-bot`, visibility **Private**
2. Do the same with [insta-engine-template](https://github.com/skoomaholic-art/insta-engine-template), name it `insta-engine`, **Private**
3. Note **`IGM_REPOSITORY`** = `your-login/insta-engine`

Keep your copies private: they will contain your posts and statistics.

### 3. GitHub token for the bot ↔ engine bridge
[Create a fine-grained token](https://github.com/settings/personal-access-tokens/new):
- Repository access: **Only select repositories → insta-engine**
- Permissions → Repository → **Contents: Read and write** (nothing else)
- Copy `github_pat_…` → **`IGM_BRIDGE_TOKEN`**

### 4. Invent three random passwords (32+ characters, no spaces)
| Name | Purpose |
|---|---|
| `TG_WEBHOOK_SECRET` | Telegram proves to the bot that an update is genuine. **You make it up** — it is not the bot token |
| `PIPELINE_SECRET` | The robot (GitHub) and the bot (Vercel) recognise each other. **Must be identical** in both places |
| `CRON_SECRET` | Protects the daily AI-editor run |

### 5. Deploy to Vercel
1. [vercel.com/new](https://vercel.com/new) → **Import** your `assistant-bot` repository → Framework Preset: **Other** → **Deploy**
2. Project → **Settings → Environment Variables** (mark each as *Sensitive*):

| Variable | Value | Required |
|---|---|---|
| `TG_BOT_TOKEN` | token from step 1 | yes |
| `TG_OWNER_CHAT_ID` | your numeric ID | yes |
| `TG_WEBHOOK_SECRET` | password from step 4 | yes |
| `IGM_BRIDGE_TOKEN` | `github_pat_…` from step 3 | yes |
| `IGM_REPOSITORY` | `your-login/insta-engine` | yes |
| `PIPELINE_SECRET` | password from step 4 | yes |
| `CRON_SECRET` | password from step 4 | yes |
| `GROQ_API_KEY` | [console.groq.com/keys](https://console.groq.com/keys) (`gsk_…`) | yes (AI) |
| `WEBAPP_HOST` | your domain without `https://`, e.g. `assistant-bot-xyz.vercel.app` | recommended |
| `GEMINI_API_KEY` | [aistudio.google.com/apikey](https://aistudio.google.com/apikey) | optional (fact-check) |

3. **Deployments → ⋯ → Redeploy** — Vercel applies variables only to a new build.

### 6. Connect the bot to Telegram
Open in a browser:
```
https://YOUR-DOMAIN.vercel.app/api/bot?install=YOUR_TG_WEBHOOK_SECRET
```
You should see "Готово" (done). Send `/start` to your bot — it replies with the Mini App buttons.
Home-screen icon: BotFather → `/mybots` → your bot → **Bot Settings → Configure Mini App → Enable Mini App** → send `https://YOUR-DOMAIN.vercel.app`. Then in the Mini App menu ⋯ choose *Add to Home Screen*.

### 7. Finish the engine
Follow the README of your `insta-engine` copy (Instagram token, GitHub secrets, first workflow runs).

### 8. Make the brand yours
In the templates the brand is `MyBrand`. Open your repo on GitHub and press `.` (web editor) → **Ctrl+Shift+H** → replace `MyBrand`, `MYBRAND`, `mybrand` with your name/handle → Commit & Push. Do it in both repositories. Upload your logo in Cover Studio → *Logo & grid*.

### 9. First test
1. `/status` in the bot — shows which keys are found and what is missing
2. Mini App → **News** → **✍️ Post** on any story: the AI recommends a format and sends the draft to the bot
3. **✅ Text OK** → the final arrives in 2–3 minutes
4. For the first run choose **📥 I'll publish myself**: the robot sends you the files without publishing

---

## Troubleshooting (real issues from real setups)

| You see | Most likely | Do this |
|---|---|---|
| BotFather: *username is already taken* | Name taken | Add digits/words, keep the `bot` ending |
| Vercel build fails with `INVALID_CRON_SECRET` | A space or line break got into `CRON_SECRET` (common when copying on a phone) | Re-enter it without spaces, Redeploy |
| Vercel: **Deployment Blocked** (commit author) | Hobby plan only builds commits authored by the Vercel account owner | Commit from your own GitHub account; make sure Vercel is linked to the same GitHub |
| You changed a variable but nothing changed | Variables apply only to new builds | **Redeploy** |
| "Неверный ключ установки" on the install URL | Wrong secret in the URL — often the bot token was pasted instead | Use your own `TG_WEBHOOK_SECRET` |
| Bot is silent on `/start` | Webhook not installed, wrong `TG_OWNER_CHAT_ID`, or no Redeploy | Check those three in that order |
| Mini App: "Доступ только у владельца" | Opened from another Telegram account or wrong ID | Re-check your ID with @userinfobot |
| "Groq rejected the key" / AI not responding | Key truncated or deleted; 429 = free-tier limit | New key + Redeploy; on 429 wait a minute |
| "No access to IGM", 404, *Bad credentials* | Token does not include `insta-engine` or lacks *Contents: Read and write* | Create a new fine-grained token as in step 3 |
| "Vercel rejected the signature" in Actions | `PIPELINE_SECRET` differs between GitHub and Vercel | Make it identical, Redeploy |
| Final never arrives (10+ min) | The robot failed | `insta-engine` → Actions → *Post Pipeline* → open the red run |
| You sent a picture and the bot made a separate post | It wasn't sent as a *reply* | Reply (swipe left) to the post's card, or use the "This is the cover for…" button |
| "AI returned too few slides" | The free model stumbled | Press **🔁 Another version** |
| No "Add to Home Screen" | Main Mini App not enabled | BotFather → Configure Mini App → Enable |

---

## Security
- The bot answers only `TG_OWNER_CHAT_ID`; every Mini App request is verified with Telegram's signed `initData`
- Telegram updates are accepted only with `TG_WEBHOOK_SECRET`; robot ↔ bot calls are HMAC-signed with `PIPELINE_SECRET`
- Nothing is published without two owner approvals (text and final); the robot re-checks both right before publishing
- Keys live only in Vercel / GitHub Secrets. Enable 2FA on Telegram, GitHub, Vercel and Meta

## Notes
- Vercel Hobby allows 12 serverless functions; this project uses exactly 12 (`api/*.js` without a leading underscore). Add features to existing endpoints.
- Reels music: Kevin MacLeod (incompetech.com), CC BY 4.0 — credited in the caption automatically.

## License
MIT — see [LICENSE](LICENSE).
