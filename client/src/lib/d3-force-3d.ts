// d3-force-3d ships runtime ESM without TypeScript declarations.
// @ts-expect-error The typed boundary below mirrors the package's public API used by the memory graph.
import * as runtime from "d3-force-3d";

export type ForceAccessor<Node, Value> = Value | ((node: Node, index: number, nodes: Node[]) => Value);
export type LinkAccessor<Link, Value> = Value | ((link: Link, index: number, links: Link[]) => Value);

export interface Force<Node> {
  (alpha: number): void;
  initialize?: (nodes: Node[], random: () => number, numDimensions: number) => void;
}

export interface Simulation<Node> {
  restart(): this;
  stop(): this;
  tick(iterations?: number): this;
  alpha(value: number): this;
  alpha(): number;
  alphaMin(value: number): this;
  alphaDecay(value: number): this;
  alphaTarget(value: number): this;
  velocityDecay(value: number): this;
  force(name: string, force: Force<Node> | null): this;
  on(name: "tick" | "end", listener: (() => void) | null): this;
}

export interface ManyBodyForce<Node> extends Force<Node> {
  strength(value: ForceAccessor<Node, number>): this;
  theta(value: number): this;
  distanceMin(value: number): this;
  distanceMax(value: number): this;
}

export interface LinkForce<Node, Link> extends Force<Node> {
  id(accessor: (node: Node, index: number, nodes: Node[]) => string | number): this;
  distance(value: LinkAccessor<Link, number>): this;
  strength(value: LinkAccessor<Link, number>): this;
  iterations(value: number): this;
}

export interface CollideForce<Node> extends Force<Node> {
  radius(value: ForceAccessor<Node, number>): this;
  strength(value: number): this;
  iterations(value: number): this;
}

export interface PositionForce<Node> extends Force<Node> {
  strength(value: ForceAccessor<Node, number>): this;
}

interface D3Force3DRuntime {
  forceSimulation: <Node extends object>(nodes?: Node[], numDimensions?: number) => Simulation<Node>;
  forceManyBody: <Node extends object>() => ManyBodyForce<Node>;
  forceLink: <Node extends object, Link extends object>(links?: Link[]) => LinkForce<Node, Link>;
  forceCollide: <Node extends object>(radius?: ForceAccessor<Node, number>) => CollideForce<Node>;
  forceX: <Node extends object>(x?: ForceAccessor<Node, number>) => PositionForce<Node>;
  forceY: <Node extends object>(y?: ForceAccessor<Node, number>) => PositionForce<Node>;
  forceZ: <Node extends object>(z?: ForceAccessor<Node, number>) => PositionForce<Node>;
}

const typedRuntime = runtime as unknown as D3Force3DRuntime;

export const forceSimulation = typedRuntime.forceSimulation;
export const forceManyBody = typedRuntime.forceManyBody;
export const forceLink = typedRuntime.forceLink;
export const forceCollide = typedRuntime.forceCollide;
export const forceX = typedRuntime.forceX;
export const forceY = typedRuntime.forceY;
export const forceZ = typedRuntime.forceZ;
