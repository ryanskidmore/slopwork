import { describe, expect, it } from "vitest";
import type { Event } from "../core/index.js";
import { eventSchema, newEventId, newTicketId } from "../core/index.js";
import {
  deriveQuestions,
  groupQuestionsByTicket,
  isAnswered,
  matchQuestionsByRef,
  unansweredQuestions,
} from "./questions.js";

function makeAskedEvent(overrides: Partial<Event> = {}): Event {
  return eventSchema.parse({
    id: newEventId(),
    actor: { name: "ryan", kind: "human" },
    session: null,
    verb: "question.asked",
    entity: { kind: "ticket", id: newTicketId() },
    payload: { text: "Which approach?", options: [] },
    at: "2026-07-23T10:00:00.000Z",
    ...overrides,
  });
}

function makeAnsweredEvent(questionId: string, overrides: Partial<Event> = {}): Event {
  return eventSchema.parse({
    id: newEventId(),
    actor: { name: "priya", kind: "human" },
    session: null,
    verb: "question.answered",
    entity: { kind: "ticket", id: newTicketId() },
    payload: { question_id: questionId, text: "Use B" },
    at: "2026-07-23T11:00:00.000Z",
    ...overrides,
  });
}

describe("deriveQuestions", () => {
  it("folds a question.asked event into an unanswered Question", () => {
    const ticketId = newTicketId();
    const asked = makeAskedEvent({
      entity: { kind: "ticket", id: ticketId },
      payload: { text: "Which approach?", options: ["A", "B"] },
      at: "2026-07-23T09:00:00.000Z",
    });
    const [question] = deriveQuestions([asked]);
    expect(question).toEqual({
      id: asked.id,
      ticketId,
      askedBy: asked.actor,
      askedAt: asked.at,
      text: "Which approach?",
      options: ["A", "B"],
      answer: null,
    });
  });

  it("defaults options to [] when payload.options is absent or not an array of strings", () => {
    const noOptions = makeAskedEvent({ payload: { text: "No options given" } });
    const badOptions = makeAskedEvent({
      payload: { text: "Bad options", options: "not an array" },
    });
    const mixedOptions = makeAskedEvent({
      payload: { text: "Mixed options", options: ["A", 2, "B"] },
    });
    expect(deriveQuestions([noOptions])[0]?.options).toEqual([]);
    expect(deriveQuestions([badOptions])[0]?.options).toEqual([]);
    // isStringArray requires EVERY element to be a string — a mixed array
    // fails the whole check and falls back to [] rather than silently
    // dropping only the non-string entries.
    expect(deriveQuestions([mixedOptions])[0]?.options).toEqual([]);
  });

  it("defaults text to '' when payload.text is missing or not a string", () => {
    const noText = makeAskedEvent({ payload: {} });
    expect(deriveQuestions([noText])[0]?.text).toBe("");
  });

  it("folds a question.answered event onto its question via payload.question_id", () => {
    const asked = makeAskedEvent();
    const answered = makeAnsweredEvent(asked.id, { payload: { question_id: asked.id, text: "B" } });
    const [question] = deriveQuestions([asked, answered]);
    expect(question?.answer).toEqual({
      id: answered.id,
      by: answered.actor,
      text: "B",
      at: answered.at,
    });
  });

  it("order of events passed in doesn't matter — the answer still attaches", () => {
    const asked = makeAskedEvent();
    const answered = makeAnsweredEvent(asked.id, { payload: { question_id: asked.id, text: "B" } });
    const [question] = deriveQuestions([answered, asked]);
    expect(question?.answer?.text).toBe("B");
  });

  it("ignores a question.answered event whose question_id doesn't match any question.asked event in this set", () => {
    const asked = makeAskedEvent();
    const dangling = makeAnsweredEvent("event_00000000000000000000000000", {
      payload: { question_id: "event_00000000000000000000000000", text: "orphaned answer" },
    });
    const [question] = deriveQuestions([asked, dangling]);
    expect(question?.answer).toBeNull();
  });

  it("ignores a question.answered event with a non-string payload.question_id", () => {
    const asked = makeAskedEvent();
    const malformed = makeAnsweredEvent(asked.id, { payload: { question_id: 42, text: "bad" } });
    const [question] = deriveQuestions([asked, malformed]);
    expect(question?.answer).toBeNull();
  });

  it("the EARLIEST answer wins when more than one question.answered event references the same question, regardless of array order", () => {
    const asked = makeAskedEvent();
    const earlier = makeAnsweredEvent(asked.id, {
      payload: { question_id: asked.id, text: "earlier answer" },
    });
    const later = makeAnsweredEvent(asked.id, {
      payload: { question_id: asked.id, text: "later answer" },
    });
    // `newEventId()` is monotonic — `later.id` sorts after `earlier.id`.
    expect(later.id > earlier.id).toBe(true);

    const inOrder = deriveQuestions([asked, earlier, later]);
    expect(inOrder[0]?.answer?.text).toBe("earlier answer");

    const reversed = deriveQuestions([asked, later, earlier]);
    expect(reversed[0]?.answer?.text).toBe("earlier answer");
  });

  it("ignores a question.asked event whose entity isn't a ticket", () => {
    const notTicket = makeAskedEvent({ entity: { kind: "session", id: "session_bogus" } });
    expect(deriveQuestions([notTicket])).toEqual([]);
  });

  it("sorts output oldest-question-first (ascending by the question's own id)", () => {
    const first = makeAskedEvent({ payload: { text: "first" } });
    const second = makeAskedEvent({ payload: { text: "second" } });
    const third = makeAskedEvent({ payload: { text: "third" } });
    // Fed in scrambled order — output must still be ascending by id.
    const result = deriveQuestions([third, first, second]);
    expect(result.map((q) => q.text)).toEqual(["first", "second", "third"]);
  });
});

describe("isAnswered / unansweredQuestions", () => {
  it("isAnswered is true iff answer is non-null", () => {
    const asked = makeAskedEvent();
    const [open] = deriveQuestions([asked]);
    if (!open) throw new Error("expected a question");
    expect(isAnswered(open)).toBe(false);

    const answered = makeAnsweredEvent(asked.id, { payload: { question_id: asked.id, text: "x" } });
    const [closed] = deriveQuestions([asked, answered]);
    if (!closed) throw new Error("expected a question");
    expect(isAnswered(closed)).toBe(true);
  });

  it("unansweredQuestions filters out answered ones, preserving order", () => {
    const a = makeAskedEvent({ payload: { text: "a" } });
    const b = makeAskedEvent({ payload: { text: "b" } });
    const c = makeAskedEvent({ payload: { text: "c" } });
    const answerB = makeAnsweredEvent(b.id, { payload: { question_id: b.id, text: "answered" } });
    const all = deriveQuestions([a, b, c, answerB]);
    expect(unansweredQuestions(all).map((q) => q.text)).toEqual(["a", "c"]);
  });
});

describe("matchQuestionsByRef", () => {
  it("matches a full question id exactly", () => {
    const asked = makeAskedEvent();
    const [question] = deriveQuestions([asked]);
    if (!question) throw new Error("expected a question");
    expect(matchQuestionsByRef([question], question.id)).toEqual([question]);
  });

  it("matches a unique short prefix", () => {
    const asked = makeAskedEvent();
    const [question] = deriveQuestions([asked]);
    if (!question) throw new Error("expected a question");
    const prefix = question.id.slice(0, 12);
    expect(matchQuestionsByRef([question], prefix)).toEqual([question]);
  });

  it("returns every match for an ambiguous prefix (never picks one silently)", () => {
    const sharedPrefixA = eventSchema.parse({
      id: "event_AAAAAAAAAAAAAAAAAAAAAAAAAA",
      actor: { name: "ryan", kind: "human" },
      session: null,
      verb: "question.asked",
      entity: { kind: "ticket", id: newTicketId() },
      payload: { text: "a" },
      at: "2026-07-23T10:00:00.000Z",
    });
    const sharedPrefixB = eventSchema.parse({
      id: "event_AAAAAAAAAAAAAAAAAAAAAAAAAB",
      actor: { name: "ryan", kind: "human" },
      session: null,
      verb: "question.asked",
      entity: { kind: "ticket", id: newTicketId() },
      payload: { text: "b" },
      at: "2026-07-23T10:00:00.000Z",
    });
    const questions = deriveQuestions([sharedPrefixA, sharedPrefixB]);
    const matches = matchQuestionsByRef(questions, "event_AAAAAAAAAAAAAAAAAAAAAAAAA");
    expect(matches).toHaveLength(2);
  });

  it("returns [] for a ref matching nothing", () => {
    const asked = makeAskedEvent();
    const [question] = deriveQuestions([asked]);
    if (!question) throw new Error("expected a question");
    expect(matchQuestionsByRef([question], "event_zzzzzzzzzzzzzzzzzzzzzzzzzz")).toEqual([]);
  });
});

describe("groupQuestionsByTicket", () => {
  it("groups questions by ticket, oldest-question-first within each group", () => {
    const ticketA = newTicketId();
    const ticketB = newTicketId();
    const a1 = makeAskedEvent({ entity: { kind: "ticket", id: ticketA }, payload: { text: "a1" } });
    const b1 = makeAskedEvent({ entity: { kind: "ticket", id: ticketB }, payload: { text: "b1" } });
    const a2 = makeAskedEvent({ entity: { kind: "ticket", id: ticketA }, payload: { text: "a2" } });

    const groups = groupQuestionsByTicket(deriveQuestions([a1, b1, a2]));
    const groupA = groups.find((g) => g.ticketId === ticketA);
    const groupB = groups.find((g) => g.ticketId === ticketB);
    expect(groupA?.questions.map((q) => q.text)).toEqual(["a1", "a2"]);
    expect(groupB?.questions.map((q) => q.text)).toEqual(["b1"]);
  });

  it("orders groups by their OLDEST question — the longest-waiting ticket sorts first, regardless of input order", () => {
    const ticketOld = newTicketId();
    const ticketNew = newTicketId();
    // Minted in this order, so oldQuestion.id < newQuestion.id (monotonic).
    const oldQuestion = makeAskedEvent({
      entity: { kind: "ticket", id: ticketOld },
      payload: { text: "old" },
    });
    const newQuestion = makeAskedEvent({
      entity: { kind: "ticket", id: ticketNew },
      payload: { text: "new" },
    });
    expect(newQuestion.id > oldQuestion.id).toBe(true);

    // Feed the NEW ticket's question first — group order must still put
    // the old-waiting ticket ahead, proving it doesn't just mirror input order.
    const groups = groupQuestionsByTicket(deriveQuestions([newQuestion, oldQuestion]));
    expect(groups.map((g) => g.ticketId)).toEqual([ticketOld, ticketNew]);
  });

  it("returns [] for an empty input", () => {
    expect(groupQuestionsByTicket([])).toEqual([]);
  });
});
