# AI Legal & Privacy Hub Data

This repository stores the public `news.json` snapshot used by the main AI Legal & Privacy Hub site.

## How it works

- `scripts/update-news.mjs` fetches the same legal and policy sources used by the main site.
- The script merges fresh RSS and Tavily-discovered items into `news.json`.
- Chinese titles and summaries are backfilled during the update run so the main site can serve a more complete bilingual feed.
- GitHub Actions runs the updater on a schedule and commits `news.json` when it changes.

## Local usage

```bash
npm install
TAVILY_API_KEY=your_key npm run update-news
```

## Required secret

- `TAVILY_API_KEY`: enables global source discovery beyond the fixed RSS feeds.
