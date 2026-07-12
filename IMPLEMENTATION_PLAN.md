# Implementation plan: Recall utterance buffering

## External contract

Current Recall meeting-bot docs distinguish `transcript.data` as a finalized transcript utterance and `transcript.partial_data` as a partial utterance. The endpoint must accept both because live acceptance showed provider/event payloads that can still arrive fragmented. Finalized events should flush immediately. Partial events should remain ephemeral and flush after a configurable silence gap.

## Design

1. Add a bounded, server-owned `MeetingUtteranceBuffer` in `server/meeting/utterance-buffer.ts`.
   - Key buffers by meeting session plus a stable speaker key.
   - Serialize updates per key so overlapping webhook callbacks cannot duplicate or reorder a finalized utterance.
   - Accumulate non-overlapping text while tolerating cumulative STT revisions.
   - Flush exactly once on explicit final or a silence timer.
   - Expose configurable silence (`MEETING_UTTERANCE_SILENCE_MS`, default 1800 ms) and bounded buffer lifetime/size.
   - Keep partial drafts in memory only. A restart may lose an unfinished partial, which is preferable to persisting shards; finalized Recall events still flush immediately.
2. Parse both `transcript.data` and `transcript.partial_data` in the Recall route, including participant identity and provider final flags where present. Route only flushed utterances through canonical `ingestMeetingEvent`, preserving one persistence and execution boundary.
3. Subscribe Recall bots to both transcript event kinds. This makes the distinction explicit and provides live buffering where supported.
4. Keep `MeetingTransport` unchanged. Finalization is a vendor ingestion concern; downstream meeting consumers should continue receiving complete attributed utterances only.

## Engineering-principle audit

- Canonical Mutation Path: only the buffer flush callback may call `ingestMeetingEvent`; partials never bypass it.
- Encode Invariants in Structure: buffer state owns timer, generation, and serialized update chain so one key has one finalization path.
- Modular Systems / Minimum Viable Protocol: isolate vendor utterance assembly in one meeting module; do not expand shared transport or client contracts without a current consumer.
- Replayability: use provider event identity when available to suppress finalized webhook retries.
- Observability: partial receipt is debug-level; finalized flush and degraded silence fallback are structured lifecycle logs without logging full private transcript text.
- Bounded resources: cap text, buffers, replay keys, and idle lifetime.

## Verification

Run `npm run build`, inspect git diff/status, run code change-scope analysis if available, then commit, push, create PR to `main`, and merge.
