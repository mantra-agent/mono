/**
 * Code-owned Metric expression contract.
 *
 * Equation text is authoring only. Query walks `plan`. This module never
 * evaluates formula text.
 */
import type { Metric } from "@shared/models/metrics";

export const EXPRESSION_MAX_DEPTH = 4;
export const EXPRESSION_MAX_OPERANDS = 8;
export const IDENTITY_STOCK_CLOCK_SLACK_MS = 5 * 60 * 1000;

export type ExpressionOp = "+" | "-" | "*" | "/";

export type ExpressionPlan =
  | { type: "metric"; metricId: string }
  | { type: "literal"; value: number }
  | { type: "op"; op: ExpressionOp; left: ExpressionPlan; right: ExpressionPlan };

/** Lone closed-producer binding written at save. Query never walks this node. */
export type ProducerPlan = { type: "producer"; key: string };

export type ExpressionCompileResult = {
  adapterKey: "expression";
  equation: string;
  plan: ExpressionPlan;
  operandIds: string[];
  operands: Metric[];
};

export type ProducerCompileResult = {
  kind: "producer";
  equation: string;
  plan: ProducerPlan;
  producerKey: string;
};

export type ComposedCompileResult = {
  kind: "expression";
} & ExpressionCompileResult;

export type MetricEquationCompileResult = ProducerCompileResult | ComposedCompileResult;

type Token =
  | { kind: "metric"; id: string }
  | { kind: "number"; value: number }
  | { kind: "op"; op: ExpressionOp }
  | { kind: "lparen" }
  | { kind: "rparen" };

export class ExpressionCompileError extends Error {
  status = 400;
  constructor(message: string) {
    super(message);
    this.name = "ExpressionCompileError";
  }
}

export function identityStockCanAnswerRange(
  range: { start: Date; end: Date },
  now = Date.now(),
): boolean {
  return range.end.getTime() >= now - IDENTITY_STOCK_CLOCK_SLACK_MS;
}

export function isExpressionPlan(value: unknown): value is ExpressionPlan {
  if (!value || typeof value !== "object") return false;
  const node = value as { type?: unknown };
  if (node.type === "metric") {
    return typeof (value as { metricId?: unknown }).metricId === "string"
      && (value as { metricId: string }).metricId.trim().length > 0;
  }
  if (node.type === "literal") {
    const raw = (value as { value?: unknown }).value;
    return typeof raw === "number" && Number.isFinite(raw);
  }
  if (node.type === "op") {
    const op = (value as { op?: unknown }).op;
    const left = (value as { left?: unknown }).left;
    const right = (value as { right?: unknown }).right;
    return (op === "+" || op === "-" || op === "*" || op === "/")
      && isExpressionPlan(left)
      && isExpressionPlan(right);
  }
  return false;
}

export function collectPlanMetricIds(plan: ExpressionPlan, into = new Set<string>()): string[] {
  if (plan.type === "metric") into.add(plan.metricId);
  else if (plan.type === "op") {
    collectPlanMetricIds(plan.left, into);
    collectPlanMetricIds(plan.right, into);
  }
  return [...into];
}

export function storedExpressionPlan(metric: Pick<Metric, "adapterKind" | "adapterConfig">): ExpressionPlan | null {
  if (metric.adapterKind !== "expression" && metric.adapterConfig?.adapterKey !== "expression") {
    return null;
  }
  return isExpressionPlan(metric.adapterConfig?.plan) ? metric.adapterConfig.plan as ExpressionPlan : null;
}

export function isProducerPlan(value: unknown): value is ProducerPlan {
  if (!value || typeof value !== "object") return false;
  const node = value as { type?: unknown; key?: unknown };
  return node.type === "producer" && typeof node.key === "string" && node.key.trim().length > 0;
}

/**
 * Authoring compile for every Metric equation.
 * Lone closed producer → producer plan. Otherwise composition over @metric: only.
 */
export async function compileMetricEquation(input: {
  equation: string;
  selfId?: string;
  isClosedProducer: (key: string) => boolean;
  loadVisibleMetric: (id: string) => Promise<Metric | null>;
}): Promise<MetricEquationCompileResult> {
  const equation = input.equation.trim();
  if (!equation) throw new ExpressionCompileError("Equation is required.");

  if (input.isClosedProducer(equation) && !/[\s+\-*/()@]/.test(equation)) {
    return {
      kind: "producer",
      equation,
      plan: { type: "producer", key: equation },
      producerKey: equation,
    };
  }

  const composed = await compileMetricExpression({
    equation,
    selfId: input.selfId,
    loadVisibleMetric: input.loadVisibleMetric,
  });
  return { kind: "expression", ...composed };
}

export async function compileMetricExpression(input: {
  equation: string;
  selfId?: string;
  loadVisibleMetric: (id: string) => Promise<Metric | null>;
}): Promise<ExpressionCompileResult> {
  const equation = input.equation.trim();
  if (!equation) throw new ExpressionCompileError("Equation is required.");

  const plan = parseEquation(equation);
  const operandIds = collectPlanMetricIds(plan);
  if (operandIds.length === 0) {
    throw new ExpressionCompileError("Equation must reference at least one metric.");
  }
  if (operandIds.length > EXPRESSION_MAX_OPERANDS) {
    throw new ExpressionCompileError(`Equation may reference at most ${EXPRESSION_MAX_OPERANDS} metrics.`);
  }
  if (input.selfId && operandIds.includes(input.selfId)) {
    throw new ExpressionCompileError("Equation cannot reference itself.");
  }

  const cache = new Map<string, Metric>();
  const operands: Metric[] = [];
  for (const id of operandIds) {
    const metric = await loadCached(id, cache, input.loadVisibleMetric);
    if (!metric) throw new ExpressionCompileError(`Unknown or invisible operand @metric:${id}.`);
    operands.push(metric);
  }

  const visiting = new Set<string>(input.selfId ? [input.selfId] : []);
  const depth = 1 + await maxReferencedDepth(operandIds, visiting, cache, input.loadVisibleMetric);
  if (depth > EXPRESSION_MAX_DEPTH) {
    throw new ExpressionCompileError(`Equation depth may not exceed ${EXPRESSION_MAX_DEPTH}.`);
  }

  return {
    adapterKey: "expression",
    equation,
    plan,
    operandIds,
    operands,
  };
}

async function loadCached(
  id: string,
  cache: Map<string, Metric>,
  loadVisibleMetric: (id: string) => Promise<Metric | null>,
): Promise<Metric | null> {
  const hit = cache.get(id);
  if (hit) return hit;
  const metric = await loadVisibleMetric(id);
  if (metric) cache.set(id, metric);
  return metric;
}

async function maxReferencedDepth(
  ids: string[],
  visiting: Set<string>,
  cache: Map<string, Metric>,
  loadVisibleMetric: (id: string) => Promise<Metric | null>,
): Promise<number> {
  let max = 0;
  for (const id of ids) {
    if (visiting.has(id)) throw new ExpressionCompileError("Equation contains a cycle.");
    const metric = await loadCached(id, cache, loadVisibleMetric);
    if (!metric) throw new ExpressionCompileError(`Unknown or invisible operand @metric:${id}.`);
    const childPlan = storedExpressionPlan(metric);
    if (!childPlan) continue;
    visiting.add(id);
    const childIds = collectPlanMetricIds(childPlan);
    const childDepth = 1 + await maxReferencedDepth(childIds, visiting, cache, loadVisibleMetric);
    visiting.delete(id);
    max = Math.max(max, childDepth);
  }
  return max;
}

function tokenize(equation: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  const source = equation;
  while (i < source.length) {
    const ch = source[i];
    if (ch === " " || ch === "\t" || ch === "\n" || ch === "\r") {
      i += 1;
      continue;
    }
    if (source.startsWith("@metric:", i)) {
      i += "@metric:".length;
      const start = i;
      while (i < source.length && !/[\s+\-*/()]/.test(source[i])) i += 1;
      const id = source.slice(start, i).trim();
      if (!id) throw new ExpressionCompileError("Equation has an empty @metric: operand.");
      tokens.push({ kind: "metric", id });
      continue;
    }
    if (ch === "(") {
      tokens.push({ kind: "lparen" });
      i += 1;
      continue;
    }
    if (ch === ")") {
      tokens.push({ kind: "rparen" });
      i += 1;
      continue;
    }
    if (ch === "+" || ch === "-" || ch === "*" || ch === "/") {
      const prev = tokens[tokens.length - 1];
      const unary = ch === "-" && (!prev || prev.kind === "op" || prev.kind === "lparen");
      if (unary) {
        let j = i + 1;
        while (j < source.length && (source[j] === " " || source[j] === "\t")) j += 1;
        if (j < source.length && /[0-9.]/.test(source[j])) {
          const { value, next } = readNumber(source, j, true);
          tokens.push({ kind: "number", value });
          i = next;
          continue;
        }
      }
      tokens.push({ kind: "op", op: ch });
      i += 1;
      continue;
    }
    if (/[0-9.]/.test(ch)) {
      const { value, next } = readNumber(source, i, false);
      tokens.push({ kind: "number", value });
      i = next;
      continue;
    }
    throw new ExpressionCompileError(`Equation has an invalid token at position ${i + 1}.`);
  }
  return tokens;
}

function readNumber(source: string, start: number, negative: boolean): { value: number; next: number } {
  let i = start;
  while (i < source.length && /[0-9.]/.test(source[i])) i += 1;
  const value = Number(`${negative ? "-" : ""}${source.slice(start, i)}`);
  if (!Number.isFinite(value)) {
    throw new ExpressionCompileError("Equation literals must be finite numbers.");
  }
  return { value, next: i };
}

function parseEquation(equation: string): ExpressionPlan {
  const tokens = tokenize(equation);
  if (tokens.length === 0) throw new ExpressionCompileError("Equation is required.");
  let index = 0;
  const peek = () => tokens[index];
  const take = () => {
    const token = tokens[index];
    if (!token) throw new ExpressionCompileError("Equation is incomplete.");
    index += 1;
    return token;
  };

  const parsePrimary = (): ExpressionPlan => {
    const token = take();
    if (token.kind === "metric") return { type: "metric", metricId: token.id };
    if (token.kind === "number") return { type: "literal", value: token.value };
    if (token.kind === "lparen") {
      const inner = parseAdd();
      if (take().kind !== "rparen") throw new ExpressionCompileError("Equation is missing a closing parenthesis.");
      return inner;
    }
    throw new ExpressionCompileError("Equation expected a metric, number, or parenthesis.");
  };

  const parseMul = (): ExpressionPlan => {
    let left = parsePrimary();
    while (peek()?.kind === "op" && ((peek() as { kind: "op"; op: ExpressionOp }).op === "*" || (peek() as { kind: "op"; op: ExpressionOp }).op === "/")) {
      const op = (take() as { kind: "op"; op: ExpressionOp }).op;
      left = { type: "op", op, left, right: parsePrimary() };
    }
    return left;
  };

  const parseAdd = (): ExpressionPlan => {
    let left = parseMul();
    while (peek()?.kind === "op" && ((peek() as { kind: "op"; op: ExpressionOp }).op === "+" || (peek() as { kind: "op"; op: ExpressionOp }).op === "-")) {
      const op = (take() as { kind: "op"; op: ExpressionOp }).op;
      left = { type: "op", op, left, right: parseMul() };
    }
    return left;
  };

  const plan = parseAdd();
  if (index !== tokens.length) throw new ExpressionCompileError("Equation has trailing tokens.");
  return foldLiterals(plan);
}

function foldLiterals(plan: ExpressionPlan): ExpressionPlan {
  if (plan.type !== "op") return plan;
  const left = foldLiterals(plan.left);
  const right = foldLiterals(plan.right);
  if (plan.op === "/" && right.type === "literal" && right.value === 0) {
    throw new ExpressionCompileError("Equation divides by zero.");
  }
  if (left.type !== "literal" || right.type !== "literal") {
    return { type: "op", op: plan.op, left, right };
  }
  const value =
    plan.op === "+" ? left.value + right.value
      : plan.op === "-" ? left.value - right.value
        : plan.op === "*" ? left.value * right.value
          : left.value / right.value;
  if (!Number.isFinite(value)) throw new ExpressionCompileError("Equation divides by zero.");
  return { type: "literal", value };
}
