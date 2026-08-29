import { DeepMutable } from '@/types/DeepMutable.types'

export function cloneDeep<T>(obj: T): DeepMutable<T> {
  return structuredClone(obj) as DeepMutable<T>
}
