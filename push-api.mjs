/**
 * push-api.mjs — 用 GitHub REST API 推送本地 commit
 * ---------------------------------------------------------------------------
 * 为什么需要它：本机到 github.com:443 的 git 通道不通（直连超时、代理 CONNECT 502），
 * 但 api.github.com 完全可用。于是走 Git Data API：
 *   blob → tree(base_tree) → commit → 更新 ref
 *
 * 安全约束：
 *   - token 只在内存里从 `git credential fill` 读取，绝不落盘、绝不打印；
 *   - 推送前核对「远端 main 的 HEAD == 本地 HEAD 的父提交」，不一致就中止，
 *     避免覆盖别人/别处的提交。
 *
 * 用法：node push-api.mjs [--dry]
 */
import { execFileSync } from "node:child_process";

const OWNER = "118coder";
const REPO = "mojuan-tauri";
const BRANCH = "main";
const API = "https://api.github.com";
const DRY = process.argv.includes("--dry");

const git = (...args) =>
  execFileSync("git", args, { encoding: "buffer", maxBuffer: 64 * 1024 * 1024 });
const gitText = (...args) => git(...args).toString("utf8");

/* ---------------------------- token ---------------------------- */
const filled = execFileSync("git", ["credential", "fill"], {
  input: "protocol=https\nhost=github.com\n\n",
  env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
  encoding: "utf8",
});
const token = filled.split("\n").find((l) => l.startsWith("password="))?.slice("password=".length)?.trim();
if (!token) {
  console.error("没有取到 token（git credential fill 无 password）");
  process.exit(2);
}

async function api(path, init = {}) {
  const res = await fetch(`${API}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "Content-Type": "application/json",
      ...(init.headers ?? {}),
    },
  });
  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { /* 非 JSON */ }
  if (!res.ok) {
    const msg = json?.message ?? text.slice(0, 300);
    throw new Error(`${init.method ?? "GET"} ${path} → ${res.status} ${msg}`);
  }
  return json;
}

/* ---------------------------- 本地状态 ---------------------------- */
const headSha = gitText("rev-parse", "HEAD").trim();
const headMsg = gitText("log", "-1", "--format=%B", "HEAD").replace(/\s+$/, "");
const parentSha = gitText("rev-parse", "HEAD^").trim();

const nameStatus = gitText("diff-tree", "-r", "--no-commit-id", "--name-status", parentSha, headSha)
  .split("\n")
  .filter(Boolean)
  .map((line) => {
    const parts = line.split("\t");
    return { status: parts[0][0], path: parts.slice(1).join("\t") };
  });

console.log(`本地 HEAD ${headSha.slice(0, 8)} / 父提交 ${parentSha.slice(0, 8)}`);
console.log(`变更 ${nameStatus.length} 个文件：`);
for (const f of nameStatus) console.log(`  ${f.status} ${f.path}`);

/* ---------------------------- 远端状态 ---------------------------- */
/*
 * 注意 sha 不等于内容：上一次推送是走 API 生成的 commit，committer 信息/时区
 * 与本地不同 → sha 不同但 tree 完全一致。所以判断「能不能接续」用 **tree**
 * 比较，而不是 sha 比较；parent 一律用远端当前的 sha。
 */
const ref = await api(`/repos/${OWNER}/${REPO}/git/ref/heads/${BRANCH}`);
const remoteSha = ref.object.sha;
const remoteCommit = await api(`/repos/${OWNER}/${REPO}/git/commits/${remoteSha}`);
const localHeadTree = gitText("rev-parse", `${headSha}^{tree}`).trim();
const localParentTree = gitText("rev-parse", `${parentSha}^{tree}`).trim();

console.log(`远端 ${BRANCH} = ${remoteSha.slice(0, 8)} (tree ${remoteCommit.tree.sha.slice(0, 8)})`);
console.log(`本地父提交 tree = ${localParentTree.slice(0, 8)}`);

if (remoteCommit.tree.sha === localHeadTree) {
  console.log("远端内容已经等于本地 HEAD，无需推送。");
  process.exit(0);
}
if (remoteCommit.tree.sha !== localParentTree) {
  console.error(
    `\n[中止] 远端 tree(${remoteCommit.tree.sha.slice(0, 8)}) 与本地父提交 tree(${localParentTree.slice(0, 8)}) 不一致。\n` +
      `说明远端有本地没有的内容。先同步远端再提交，避免覆盖。`,
  );
  process.exit(3);
}

if (DRY) {
  console.log("\n--dry：只做检查，不写入。");
  process.exit(0);
}

/* ---------------------------- blob ---------------------------- */
const modeOf = (path) => {
  const m = gitText("ls-tree", headSha, "--", path).trim().slice(0, 6);
  return m || "100644";
};

const tree = [];
for (const f of nameStatus) {
  if (f.status === "D") {
    tree.push({ path: f.path, mode: "100644", type: "blob", sha: null });
    console.log(`  delete ${f.path}`);
    continue;
  }
  const buf = git("cat-file", "blob", `${headSha}:${f.path}`);
  const blob = await api(`/repos/${OWNER}/${REPO}/git/blobs`, {
    method: "POST",
    body: JSON.stringify({ content: buf.toString("base64"), encoding: "base64" }),
  });
  tree.push({ path: f.path, mode: modeOf(f.path), type: "blob", sha: blob.sha });
  console.log(`  ${f.status} ${f.path} → ${blob.sha.slice(0, 8)} (${buf.length}B)`);
}

/* ---------------------------- tree / commit / ref ---------------------------- */
const newTree = await api(`/repos/${OWNER}/${REPO}/git/trees`, {
  method: "POST",
  body: JSON.stringify({ base_tree: remoteCommit.tree.sha, tree }),
});
console.log(`新 tree = ${newTree.sha}`);

const newCommit = await api(`/repos/${OWNER}/${REPO}/git/commits`, {
  method: "POST",
  body: JSON.stringify({ message: headMsg, tree: newTree.sha, parents: [remoteSha] }),
});
console.log(`新 commit = ${newCommit.sha}`);

if (newCommit.sha !== headSha) {
  console.log(
    `\n注意：远端生成的 commit sha(${newCommit.sha.slice(0, 8)}) 与本地(${headSha.slice(0, 8)}) 不同。\n` +
      `原因通常是本地 commit 的 committer 信息 / 时区与 API 不同。代码内容一致，不影响构建。`,
  );
}

const updated = await api(`/repos/${OWNER}/${REPO}/git/refs/heads/${BRANCH}`, {
  method: "PATCH",
  body: JSON.stringify({ sha: newCommit.sha, force: false }),
});
console.log(`\n✅ ${BRANCH} 已更新到 ${updated.object.sha.slice(0, 8)}`);
console.log(`Actions: https://github.com/${OWNER}/${REPO}/actions`);
