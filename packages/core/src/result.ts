/* eslint-disable local/no-try-catch */
type OkEnum<T> = {
  ok: true;
  data: T;
  error: null;
};

type ErrEnum<E> = {
  ok: false;
  data: null;
  error: E;
};

type ResultEnum<T, E = null> = OkEnum<T> | ErrEnum<E>;

type Result<T, E = null> = ResultEnum<T, E>;

const Ok = <T>(value: T): OkEnum<T> => {
  return { ok: true, data: value, error: null };
};

const Err = <E>(value: E): ErrEnum<E> => {
  return { ok: false, data: null, error: value };
};

const toError = (thrown: unknown): Error => {
  if (thrown instanceof Error) return thrown;
  return new Error(String(thrown));
};

const Result = {
  from: async <K>(fn: () => K): Promise<ResultEnum<Awaited<K>, Error>> => {
    try {
      const value = await fn();
      return Ok(value);
    } catch (error) {
      return Err(toError(error));
    }
  },

  fromSync: <K>(fn: () => K): ResultEnum<K, Error> => {
    try {
      const value = fn();
      return Ok(value);
    } catch (error) {
      return Err(toError(error));
    }
  },
};

export { Ok, Err, Result };
export type { OkEnum, ErrEnum, ResultEnum };
