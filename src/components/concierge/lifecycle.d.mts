export interface ConciergeLifecycle {
  pageLoad(): void;
  beforeSwap(): void;
  pageHide(): void;
}

export function createConciergeLifecycle<T>(boundary: {
  findRoot(): T | null;
  bind(root: T): void;
  unbind(): void;
  dispose(): void;
}): ConciergeLifecycle;
