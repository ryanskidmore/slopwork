/**
 * Core domain layer.
 *
 * A2 lands here: entity types + zod schemas for the five v0 objects
 * (design.md §4.1: Ticket, Edge, Session, Event, Actor) plus Config, the
 * spec JSON shape (D10), prefixed ULID generation (D6), slugs (D12),
 * duration parsing, the clock seam, and JSONC read/write (per the S3
 * spike decision, spikes/jsonc.md). Pure, in-memory, and testable only —
 * no file I/O, no repo layer, no CLI wiring; that's A3.
 */
export * from "./budget.js";
export * from "./clock.js";
export * from "./duration.js";
export * from "./entities/index.js";
export * from "./exit-codes.js";
export * from "./ids.js";
export * from "./jsonc.js";
export * from "./slug.js";
export * from "./timestamp.js";
