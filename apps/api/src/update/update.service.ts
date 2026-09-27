import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { currentOperatorId } from '../common/operator-context';

/**
 * 自动更新（I13）· 方案①「宿主更新代理」：
 *  - 本服务只负责：比对 GitHub 版本 → 下载新版本包 → 写「更新请求」文件
 *  - 真正执行（备份 → 替换代码 → docker compose build/up → 健康校验）由宿主机上的
 *    auto-update.bat / deploy\fms-updater.ps1 完成——容器不持有 Docker 权限
 */
const UPDATES_DIR = process.env.FMS_UPDATES_DIR ?? '/app/updates';
const GH = 'https://api.github.com';

interface GhCommit {
  sha: string;
  commit: { message?: string; author?: { date?: string; name?: string } };
}

@Injectable()
export class UpdateService {
  private readonly logger = new Logger(UpdateService.name);

  private get repo(): string { return process.env.FMS_UPDATE_REPO ?? ''; }
  private get branch(): string { return process.env.FMS_UPDATE_BRANCH ?? 'main'; }
  private get currentSha(): string { return process.env.FMS_BUILD_SHA ?? 'unknown'; }

  private headers(): Record<string, string> {
    const h: Record<string, string> = { Accept: 'application/vnd.github+json', 'User-Agent': 'fms-update' };
    const t = process.env.FMS_UPDATE_TOKEN;
    if (t) h.Authorization = `Bearer ${t}`;
    return h;
  }

  private async gh<T>(path: string): Promise<T> {
    const res = await fetch(`${GH}${path}`, { headers: this.headers() });
    if (!res.ok) {
      const hint = res.status === 404 ? '（仓库不存在，或私有仓库未配置 FMS_UPDATE_TOKEN）' : '';
      throw new BadRequestException(`GitHub 返回 HTTP ${res.status}${hint}`);
    }
    return (await res.json()) as T;
  }

  /** 宿主更新代理状态（由 auto-update.bat 写入 updates/agent.status） */
  private async agentStatus() {
    try {
      // 兼容带 BOM 的文件（PowerShell Set-Content -Encoding UTF8 会写 BOM）
      const raw = (await readFile(join(UPDATES_DIR, 'agent.status'), 'utf8')).replace(/^\uFEFF/, '');
      const j = JSON.parse(raw) as {
        lastRunAt?: string; lastResult?: string; version?: string;
      };
      const ageMin = (Date.now() - new Date(j.lastRunAt ?? 0).getTime()) / 60000;
      return { installed: true, online: ageMin < 15, lastRunAt: j.lastRunAt ?? null, lastResult: j.lastResult ?? null, version: j.version ?? null };
    } catch {
      return { installed: false, online: false, lastRunAt: null, lastResult: null, version: null };
    }
  }

  private async pendingRequest() {
    try {
      const raw = (await readFile(join(UPDATES_DIR, 'apply.request'), 'utf8')).replace(/^\uFEFF/, '');
      return JSON.parse(raw);
    } catch { return null; }
  }

  /** 版本比对：当前构建号 vs GitHub 最新提交 */
  async status() {
    const agent = await this.agentStatus();
    const pendingRequest = await this.pendingRequest();
    if (!this.repo) {
      return { configured: false, message: '未配置 FMS_UPDATE_REPO（.env 中填写 GitHub 仓库 owner/name）', currentSha: this.currentSha, agent, pendingRequest };
    }
    const commits = await this.gh<GhCommit[]>(`/repos/${this.repo}/commits?sha=${this.branch}&per_page=10`);
    const latest = commits[0];
    const current = this.currentSha;
    return {
      configured: true,
      repo: this.repo,
      branch: this.branch,
      repoUrl: `https://github.com/${this.repo}`,
      currentSha: current,
      currentShort: current === 'unknown' ? '未知（旧版本包未带构建号）' : current.slice(0, 7),
      latestSha: latest?.sha ?? null,
      latestShort: (latest?.sha ?? '').slice(0, 7),
      latestDate: latest?.commit?.author?.date ?? null,
      latestMessage: (latest?.commit?.message ?? '').split('\n')[0],
      hasUpdate: !!latest && current !== 'unknown' && latest.sha !== current,
      changelog: commits.map((c) => ({
        sha: c.sha.slice(0, 7),
        message: (c.commit?.message ?? '').split('\n')[0],
        date: c.commit?.author?.date ?? null,
        author: c.commit?.author?.name ?? null,
      })),
      checkedAt: new Date().toISOString(),
      agent,
      pendingRequest,
    };
  }

  /**
   * 下载更新包到共享 updates 目录（供宿主代理使用）。
   * 优先级：① Release 里 CI 打好的 `fms-*.zip` 包 ② 分支 zipball。
   * 一律用 .zip：Windows 自带 Expand-Archive 即可解压，**新机无需 git / tar**。
   */
  async download() {
    if (!this.repo) throw new BadRequestException('未配置更新源（FMS_UPDATE_REPO）');
    await mkdir(UPDATES_DIR, { recursive: true });

    let url = '';
    let name = '';
    let kind: 'package' | 'zipball' = 'zipball';
    let tag: string | null = null;
    try {
      const rel = await this.gh<{ tag_name?: string; assets?: Array<{ name: string; browser_download_url: string }> }>(
        `/repos/${this.repo}/releases/latest`,
      );
      const asset = (rel.assets ?? []).find((a) => /\.zip$/i.test(a.name) && /fms/i.test(a.name));
      if (asset) { url = asset.browser_download_url; name = asset.name; kind = 'package'; tag = rel.tag_name ?? null; }
    } catch { /* 无 Release 时退回 zipball */ }

    const commits = await this.gh<GhCommit[]>(`/repos/${this.repo}/commits?sha=${this.branch}&per_page=1`);
    let sha = commits[0]?.sha ?? '';
    // 用 Release 包时，版本号应取 tag 指向的提交（而非分支 HEAD），否则页面显示的版本会偏新
    if (kind === 'package' && tag) {
      try {
        const tagCommit = await this.gh<{ sha: string }>('/repos/' + this.repo + '/commits/' + encodeURIComponent(tag));
        if (tagCommit?.sha) sha = tagCommit.sha;
      } catch { /* 取不到 tag 提交时保留分支 HEAD */ }
    }
    if (!url) {
      if (!sha) throw new BadRequestException('未取到远端提交');
      url = `${GH}/repos/${this.repo}/zipball/${sha}`;
      name = `fms-${sha.slice(0, 7)}.zip`;
    }

    const res = await fetch(url, { headers: this.headers(), redirect: 'follow' });
    if (!res.ok) throw new BadRequestException(`下载失败：HTTP ${res.status}`);
    const buf = Buffer.from(await res.arrayBuffer());
    const file = join(UPDATES_DIR, name);
    await writeFile(file, buf);
    const sha256 = createHash('sha256').update(buf).digest('hex').toUpperCase();
    this.logger.log(`update downloaded: ${kind} ${file} ${buf.length} bytes`);
    return { file, name, bytes: buf.length, sha256, kind, tag, targetSha: sha || tag || '', targetShort: (sha || tag || '').slice(0, 7) };
  }

  /** 提交更新请求：由宿主代理执行；无代理时提示手动升级 */
  async apply() {
    const st = await this.status();
    if (!st.configured) throw new BadRequestException('未配置更新源（FMS_UPDATE_REPO）');
    const dl = await this.download();
    await mkdir(UPDATES_DIR, { recursive: true });
    const request = {
      requestedAt: new Date().toISOString(),
      targetSha: dl.targetSha,
      targetShort: dl.targetShort,
      // file 为容器内路径（展示用）；fileName 供宿主机在 updates 目录内解析
      file: dl.file,
      fileName: dl.name,
      sha256: dl.sha256,
      operatorId: currentOperatorId(),
    };
    await writeFile(join(UPDATES_DIR, 'apply.request'), JSON.stringify(request, null, 2), 'utf8');
    const agent = st.agent as { online?: boolean };
    return {
      mode: agent?.online ? 'agent' : 'manual',
      request,
      message: agent?.online
        ? '更新请求已提交：宿主更新代理将自动执行「备份数据库 → 替换代码 → 重建并重启 → 健康校验」，约 1-3 分钟后刷新页面即可'
        : '更新包已下载到 updates 目录。未检测到宿主更新代理，请在服务器上双击 system\\upgrade.bat（它会自动应用已下载的更新包：备份 → 覆盖 → 重建 → 健康校验）；想全自动则安装代理：system\\auto-update.bat install',
    };
  }
}
