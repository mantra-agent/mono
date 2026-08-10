import { availableParallelism } from "node:os";
import { readFile } from "node:fs/promises";

export type CpuAllocationSource = "cgroup-v2" | "cgroup-v1" | "process-affinity";

export interface CpuAllocation {
  vCpus: number;
  source: CpuAllocationSource;
}

const CGROUP_V2_CPU_MAX = "/sys/fs/cgroup/cpu.max";
const CGROUP_V1_QUOTA = "/sys/fs/cgroup/cpu/cpu.cfs_quota_us";
const CGROUP_V1_PERIOD = "/sys/fs/cgroup/cpu/cpu.cfs_period_us";

async function readText(path: string): Promise<string | null> {
  try {
    return (await readFile(path, "utf8")).trim();
  } catch {
    return null;
  }
}

function quotaToVcpus(quota: number, period: number): number | null {
  if (!Number.isFinite(quota) || !Number.isFinite(period) || quota <= 0 || period <= 0) return null;
  return quota / period;
}

async function readCgroupV2Quota(): Promise<number | null> {
  const value = await readText(CGROUP_V2_CPU_MAX);
  if (!value) return null;
  const [quotaValue, periodValue] = value.split(/\s+/);
  if (quotaValue === "max") return null;
  return quotaToVcpus(Number(quotaValue), Number(periodValue));
}

async function readCgroupV1Quota(): Promise<number | null> {
  const [quotaValue, periodValue] = await Promise.all([
    readText(CGROUP_V1_QUOTA),
    readText(CGROUP_V1_PERIOD),
  ]);
  if (!quotaValue || !periodValue) return null;
  return quotaToVcpus(Number(quotaValue), Number(periodValue));
}

export async function resolveEffectiveCpuAllocation(): Promise<CpuAllocation> {
  const cgroupV2 = await readCgroupV2Quota();
  if (cgroupV2 !== null) return { vCpus: cgroupV2, source: "cgroup-v2" };

  const cgroupV1 = await readCgroupV1Quota();
  if (cgroupV1 !== null) return { vCpus: cgroupV1, source: "cgroup-v1" };

  const affinityLimit = availableParallelism();
  if (Number.isFinite(affinityLimit) && affinityLimit > 0) {
    return { vCpus: affinityLimit, source: "process-affinity" };
  }

  throw new Error("No effective CPU allocation is visible to this process");
}
