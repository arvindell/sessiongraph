import { hash } from './layout';
import type { GraphNode } from './types';

export const SPIRAL_PITCH = 32;
export const SPIRAL_RAMP = 4;
export const SPIRAL_RATE = 2 * Math.PI / SPIRAL_PITCH;
export const SPIRAL_BASE = .02;
export const SPIRAL_WIDTH = .18;

function spiral(node: GraphNode, x: number) {
  const distance = Math.max(0, x - node.startPosition[0]);
  const ramp = Math.min(1, distance / SPIRAL_RAMP), size = SPIRAL_BASE + node.radius * SPIRAL_WIDTH;
  return {
    angle: distance * SPIRAL_RATE + hash(node.session.id) * 2 * Math.PI,
    amplitude: size * ramp * ramp * (3 - 2 * ramp),
    derivative: distance < SPIRAL_RAMP ? size * 6 * ramp * (1 - ramp) / SPIRAL_RAMP : 0,
  };
}

/** A fixed trajectory: old dots stay put when the endpoint extends or playback moves. */
export function spiralPosition(node: GraphNode, x: number): [number, number, number] {
  const { angle, amplitude } = spiral(node, x);
  return [x, node.position[1] + Math.cos(angle) * amplitude, node.position[2] + Math.sin(angle) * amplitude];
}

export function spiralTangent(node: GraphNode, x: number): [number, number, number] {
  const { angle, amplitude, derivative } = spiral(node, x);
  return [1, Math.cos(angle) * derivative - Math.sin(angle) * amplitude * SPIRAL_RATE, Math.sin(angle) * derivative + Math.cos(angle) * amplitude * SPIRAL_RATE];
}
