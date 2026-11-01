# Feed Fixer

Describe the YouTube feed you want. Claude Code finds 10-25 creators in that niche, and the extension trains your recommendations toward them. It likes their latest videos, subscribes, watches a little of each, and marks off-niche videos on your home feed "Not interested".

It uses your Claude Code login, not an API key. A tiny local bridge runs `claude -p` for the three AI steps.

## Setup

1. Install the bridge as a login service (needs Node 20+ and `claude` on your PATH, logged in):

   ```sh
   scripts/install-bridge.sh            # starts now and at every login; logs in ~/Library/Logs/feed-bridge.log
   scripts/install-bridge.sh uninstall  # removes it
   ```

   Or run it in the foreground with `npm run bridge`. If you switch Node versions with nvm, rerun the install script.

2. Load the extension. Open `chrome://extensions`, turn on Developer mode, click **Load unpacked**, and pick the `extension/` folder.
3. Make sure you're signed in to YouTube in that Chrome profile.
4. Click the Feed Fixer toolbar icon. Describe your feed and hit **Fix my feed**. Keep the dashboard tab open until it finishes.

## What a run does

1. **Plan.** Claude turns your description into a one-line niche, a list of things to avoid, and 10 YouTube search queries.
2. **Search.** Each query runs twice on YouTube (video results and channel results). The top 60 channels get their recent upload titles pulled from RSS.
3. **Pick.** Claude ranks those real channels and picks your creator count. It can only choose from what search returned, so it can't invent a channel.
4. **Videos.** Pulls each creator's latest long-form uploads from their Videos tab (no Shorts).
5. **Engage.** Opens small popup windows (3 by default) that each work through the queue. Every video gets liked. The first video per creator also gets a subscribe, and the latest N per creator get watched muted for a few seconds so they land in your watch history.
6. **Prune.** Loads your home feed, has Claude flag videos that clearly don't fit, and clicks "Not interested" on each one.

Runs are paced to a target duration (20 minutes by default). Videos are spread evenly across it with random gaps, so it looks less like a bot. The dashboard warns you if your settings can't fit in the target.

## Settings

| Setting | Default | Notes |
| --- | --- | --- |
| Creators | 15 | 5-25 |
| Videos per creator | 10 | |
| Watch latest N per creator | 3 | Watch history is the strongest signal, but it costs the most time |
| Seconds watched each | 20 | |
| Parallel windows | 3 | More only matters if the target is too short for the work |
| Target minutes | 20 | How long the run is spread over |

The bridge uses `sonnet` by default. Set `FEED_MODEL=haiku npm run bridge` for faster, cheaper calls, or `PORT=...` to move it off 4777 (and change `BRIDGE` in `extension/app.js` to match).

## Caveats

- It drives YouTube's real UI, so a YouTube redesign can break the selectors in `extension/page.js`. They're English-only ("Subscribe", "Not interested").
- Even spread over 20 minutes, 150 likes in one sitting is more than most people do. A longer target, fewer creators, or more watching and less liking is gentler on your account.
- The bridge listens only on 127.0.0.1, requires the extension's `x-feed-fixer` header, refuses web-page origins and foreign Host headers, and runs Claude with all tools disabled.
