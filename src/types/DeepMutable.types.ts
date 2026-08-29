export type DeepMutable<T> = {
  -readonly [K in keyof T]: T[K] extends readonly (infer R)[]
    ? DeepMutable<R>[] // Converts readonly arrays to regular arrays
    : T[K] extends object
      ? DeepMutable<T[K]> // Recursively handles nested objects
      : T[K]
}
