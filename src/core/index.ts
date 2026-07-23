/**
 * Core domain layer.
 *
 * Landing here in later work items:
 *  - A2: entity types + zod schemas for the five v0 objects (design.md
 *    §4.1: Ticket, Edge, Session, Event, Actor), the spec JSON shape
 *    (D10), prefixed ULID generation, and JSONC read/write helpers
 *    (per the S3 spike decision).
 *
 * A1 only establishes the module and re-exports what already exists
 * (exit codes) so other layers have a single stable import surface as
 * this fills in.
 */
export * from "./exit-codes.js";
