import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { pickEditorCommand } from "./edit.js";

// windows-portability-fsyncdir-crlf-gitignore-cwd-mangling-edi:
//
// `pickEditorCommand` used to fall back unconditionally to `vi`, which
// isn't present on stock Windows. These tests prove the existing
// $VISUAL/$EDITOR precedence is unchanged, and that the platform-dependent
// fallback picks `notepad` on win32 and `vi` everywhere else (mocking
// `process.platform` since this suite runs on a Linux host).

describe("pickEditorCommand", () => {
  const originalPlatform = process.platform;
  const originalVisual = process.env.VISUAL;
  const originalEditor = process.env.EDITOR;

  beforeEach(() => {
    delete process.env.VISUAL;
    delete process.env.EDITOR;
  });

  afterEach(() => {
    Object.defineProperty(process, "platform", {
      value: originalPlatform,
      configurable: true,
    });
    if (originalVisual === undefined) delete process.env.VISUAL;
    else process.env.VISUAL = originalVisual;
    if (originalEditor === undefined) delete process.env.EDITOR;
    else process.env.EDITOR = originalEditor;
  });

  it("prefers $VISUAL over $EDITOR and over any platform default", () => {
    process.env.VISUAL = "code --wait";
    process.env.EDITOR = "nano";
    expect(pickEditorCommand()).toBe("code --wait");
  });

  it("falls back to $EDITOR when $VISUAL is unset", () => {
    process.env.EDITOR = "nano";
    expect(pickEditorCommand()).toBe("nano");
  });

  it("falls back to vi on posix (linux) when neither $VISUAL nor $EDITOR is set", () => {
    Object.defineProperty(process, "platform", { value: "linux", configurable: true });
    expect(pickEditorCommand()).toBe("vi");
  });

  it("falls back to vi on darwin too (POSIX default unchanged, not just linux)", () => {
    Object.defineProperty(process, "platform", { value: "darwin", configurable: true });
    expect(pickEditorCommand()).toBe("vi");
  });

  it("falls back to notepad on win32 when neither $VISUAL nor $EDITOR is set", () => {
    Object.defineProperty(process, "platform", { value: "win32", configurable: true });
    expect(pickEditorCommand()).toBe("notepad");
  });

  it("$VISUAL/$EDITOR still win over the win32 default", () => {
    Object.defineProperty(process, "platform", { value: "win32", configurable: true });
    process.env.EDITOR = "vim";
    expect(pickEditorCommand()).toBe("vim");
  });
});
