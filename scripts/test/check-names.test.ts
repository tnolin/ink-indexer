import { spawnSync } from "node:child_process"
import { mkdirSync, mkdtempSync, rmSync, unlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { afterEach, describe, expect, it } from "vitest"

const script = resolve(__dirname, "../check-names.sh")
const dirs: string[] = []

function repo(files: Record<string, string>, untracked: Record<string, string> = {}): string {
  const cwd = mkdtempSync(join(tmpdir(), "check-names-"))
  dirs.push(cwd)
  const git = (...args: string[]) => {
    const r = spawnSync("git", args, { cwd, encoding: "utf8" })
    if (r.status !== 0) throw new Error(`git ${args[0]} failed: ${r.stderr}`)
  }
  git("init", "-q")
  const put = (name: string, content: string) => {
    mkdirSync(dirname(join(cwd, name)), { recursive: true })
    writeFileSync(join(cwd, name), content)
  }
  for (const [name, content] of Object.entries(files)) put(name, content)
  git("add", "-A")
  for (const [name, content] of Object.entries(untracked)) put(name, content)
  return cwd
}

function run(cwd: string, env: Record<string, string | undefined>) {
  const base: Record<string, string | undefined> = {
    PATH: process.env.PATH,
    HOME: process.env.HOME,
  }
  const r = spawnSync("bash", [script], { cwd, env: { ...base, ...env }, encoding: "utf8" })
  return { status: r.status, stdout: r.stdout, stderr: r.stderr, all: r.stdout + r.stderr }
}

afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

describe("check-names.sh", () => {
  it("a hit prints path:line and nothing of the word", () => {
    const cwd = repo({ "a.txt": "fine\nsome zorblax here\n" })
    const r = run(cwd, { GUARD_PATTERN: "zorblax", GUARD_ALLOW: "" })
    expect(r.status).toBe(1)
    expect(r.stdout.trim()).toBe("a.txt:2")
    expect(r.all.toLowerCase()).not.toContain("zorblax")
  })

  it("an allowed phrase does not hit, but a forbidden word on the same line does", () => {
    const cwd = repo({ "a.txt": "zorblax-ok\nzorblax-ok and zorblax\n" })
    const r = run(cwd, { GUARD_PATTERN: "zorblax", GUARD_ALLOW: "zorblax-ok" })
    expect(r.status).toBe(1)
    expect(r.stdout.trim()).toBe("a.txt:2")
  })

  it("an empty GUARD_ALLOW still lets a forbidden word hit", () => {
    const cwd = repo({ "a.txt": "zorblax first\nlater zorblax\n" })
    const r = run(cwd, { GUARD_PATTERN: "zorblax", GUARD_ALLOW: "" })
    expect(r.status).toBe(1)
    expect(r.stdout.trim().split("\n")).toEqual(["a.txt:1", "a.txt:2"])
  })

  it("an unset GUARD_ALLOW still lets a forbidden word hit", () => {
    const cwd = repo({ "a.txt": "zorblax first\nlater zorblax\n" })
    const r = run(cwd, { GUARD_PATTERN: "zorblax" })
    expect(r.status).toBe(1)
    expect(r.stdout.trim().split("\n")).toEqual(["a.txt:1", "a.txt:2"])
  })

  it("matching is case-insensitive", () => {
    const cwd = repo({ "a.txt": "ZoRbLaX\n", "b.txt": "zorblax-OK\n" })
    const r = run(cwd, { GUARD_PATTERN: "zorblax", GUARD_ALLOW: "ZORBLAX-ok" })
    expect(r.status).toBe(1)
    expect(r.stdout.trim()).toBe("a.txt:1")
  })

  it("pnpm-lock.yaml, a nested pnpm-lock.yaml, pnpm-workspace.yaml and a .png do not hit", () => {
    const cwd = repo({
      "pnpm-lock.yaml": "zorblax\n",
      "sub/pnpm-lock.yaml": "zorblax\n",
      "pnpm-workspace.yaml": "zorblax\n",
      "logo.png": "zorblax\n",
      "ok.txt": "clean\n",
    })
    const r = run(cwd, { GUARD_PATTERN: "zorblax", GUARD_ALLOW: "" })
    expect(r.status).toBe(0)
    expect(r.all).toBe("")
  })

  it("a file whose name contains lock, and notes.png.md, are scanned", () => {
    const cwd = repo({
      "docs/adr/0046-block-lock-notes.md": "zorblax\n",
      "notes.png.md": "zorblax\n",
    })
    const r = run(cwd, { GUARD_PATTERN: "zorblax", GUARD_ALLOW: "" })
    expect(r.status).toBe(1)
    expect(r.stdout.trim().split("\n").sort()).toEqual([
      "docs/adr/0046-block-lock-notes.md:1",
      "notes.png.md:1",
    ])
  })

  it("a tracked file deleted from the worktree is skipped; an untracked file is not scanned", () => {
    const cwd = repo({ "gone.txt": "zorblax\n", "ok.txt": "clean\n" }, { "new.txt": "zorblax\n" })
    unlinkSync(join(cwd, "gone.txt"))
    const r = run(cwd, { GUARD_PATTERN: "zorblax", GUARD_ALLOW: "" })
    expect(r.status).toBe(0)
    expect(r.all).toBe("")
  })

  it("a last line without a newline is reported", () => {
    const cwd = repo({ "a.txt": "clean\nzorblax" })
    const r = run(cwd, { GUARD_PATTERN: "zorblax", GUARD_ALLOW: "" })
    expect(r.status).toBe(1)
    expect(r.stdout.trim()).toBe("a.txt:2")
  })

  it("a pattern with a trailing newline or CRLF behaves like the pattern without it", () => {
    const cwd = repo({ "a.txt": "zorblax\n", "b.txt": "clean\n" })
    for (const suffix of ["\n", "\r\n"]) {
      const r = run(cwd, { GUARD_PATTERN: `zorblax${suffix}`, GUARD_ALLOW: `zorblax-ok${suffix}` })
      expect(r.status).toBe(1)
      expect(r.stdout.trim()).toBe("a.txt:1")
    }
  })

  it("an empty pattern fails", () => {
    const cwd = repo({ "a.txt": "anything\n" })
    for (const env of [{ GUARD_PATTERN: "" }, {}, { GUARD_PATTERN: "\r\n" }]) {
      const r = run(cwd, env)
      expect(r.status).toBe(1)
      expect(r.stderr + r.stdout).toContain("guard: GUARD_PATTERN is empty")
    }
  })

  it("an empty pattern with GUARD_FORK=true passes with a warning", () => {
    const cwd = repo({ "a.txt": "anything\n" })
    const r = run(cwd, { GUARD_PATTERN: "", GUARD_FORK: "true" })
    expect(r.status).toBe(0)
    expect(r.stderr).toContain("guard skipped: no patterns (pull request from a fork)")
  })

  it("no output, on a hit or on a failure, contains either pattern", () => {
    const cwd = repo({ "a.txt": "zorblax and quuxle\n" })
    const hit = run(cwd, { GUARD_PATTERN: "zorblax", GUARD_ALLOW: "quuxle" })
    const bad = run(cwd, { GUARD_PATTERN: "zorblax(", GUARD_ALLOW: "quuxle" })
    for (const r of [hit, bad]) {
      expect(r.all).not.toContain("zorblax")
      expect(r.all).not.toContain("quuxle")
    }
  })

  it("an invalid pattern exits 2 without printing it", () => {
    const cwd = repo({ "a.txt": "x\n" })
    for (const env of [
      { GUARD_PATTERN: "zorb(lax", GUARD_ALLOW: "" },
      { GUARD_PATTERN: "zorblax", GUARD_ALLOW: "quux(le" },
    ]) {
      const r = run(cwd, env)
      expect(r.status).toBe(2)
      expect(r.stderr.trim()).toBe("guard: a pattern does not compile")
      expect(r.stdout).toBe("")
      expect(r.all).not.toContain("zorb")
      expect(r.all).not.toContain("quux")
    }
  })

  it("a pattern with an unknown escape (zorbl\\yax) leaves no part of it on stderr", () => {
    const cwd = repo({ "a.txt": "zorblyax\n" })
    const r = run(cwd, { GUARD_PATTERN: "zorbl\\yax", GUARD_ALLOW: "" })
    expect(r.stderr).toBe("")
    expect(r.all).not.toContain("zorbl")
    expect(r.stdout.trim()).toBe("a.txt:1")
  })

  it("an allowed phrase between two halves of a forbidden word does not join them", () => {
    const cwd = repo({ "a.txt": "zorb-ok-lax\n" })
    const r = run(cwd, { GUARD_PATTERN: "zorblax", GUARD_ALLOW: "-ok-" })
    expect(r.status).toBe(0)
    expect(r.all).toBe("")
  })

  it("a pattern that fails only at match time exits 2 without printing it", () => {
    const cwd = repo({ "a.txt": "zorblax\n" })
    for (const env of [
      { GUARD_PATTERN: "zorb\\p{IsQuuxle}lax", GUARD_ALLOW: "" },
      { GUARD_PATTERN: "zorblax", GUARD_ALLOW: "zorb\\p{IsQuuxle}lax" },
    ]) {
      const r = run(cwd, env)
      expect(r.status).toBe(2)
      expect(r.stdout).toBe("")
      expect(r.stderr.trim()).toBe("guard: a pattern does not compile")
      expect(r.all).not.toContain("zorb")
      expect(r.all).not.toContain("Quuxle")
    }
  })

  it("an allowed-phrase pattern that matches empty text exits 2", () => {
    const cwd = repo({ "a.txt": "zorblax\n" })
    for (const allow of ["quux|", "x?"]) {
      const r = run(cwd, { GUARD_PATTERN: "zorblax", GUARD_ALLOW: allow })
      expect(r.status).toBe(2)
      expect(r.stdout).toBe("")
      expect(r.stderr.trim()).toBe("guard: a pattern does not compile")
    }
  })

  it("a clean repo exits 0", () => {
    const cwd = repo({ "a.txt": "nothing here\n", "src/b.ts": "export {}\n" })
    const r = run(cwd, { GUARD_PATTERN: "zorblax", GUARD_ALLOW: "zorblax-ok" })
    expect(r.status).toBe(0)
    expect(r.all).toBe("")
  })
})
