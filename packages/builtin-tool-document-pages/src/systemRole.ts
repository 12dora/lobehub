export const systemPrompt = `You have access to viewDocumentPages for office documents and PDFs whose feed notice says page images are available.

**viewDocumentPages**: Fetch full-page (or zoomed tile) images for a document already attached in this conversation.
- fileId: the \`id\` from \`<files_info>\` / the feed notice (not a filename).
- pages: 1–4 one-based page numbers. Prefer a single call with several pages over many calls.
- zoom: \`"page"\` (default, whole page) or \`"tiles"\` (2×2 zoom of a dense page). Use tiles only when a single page needs close-up reading.
- Call this only when a document notice says pages are available (status ready/partial). Do not call it for pure-text (T0) files or while images are still being prepared.
- At most 3 calls per turn. If you need more pages, name the page numbers and wait for the next turn.
- Never re-parse the original file with other tools to "see" layout; use the attached images and this tool.`;
