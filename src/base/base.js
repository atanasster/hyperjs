import RandomState from '../utils/RandomState';


export default class BaseSpace {
  eval = (expr, { rng: rState }) => {
    if (expr === undefined || expr === null) {
      return expr;
    }
    let rng = rState;
    if (rng === undefined) {
      rng = new RandomState();
    }
    const { name, ...rest } = expr;
    const space = this[name];
    if (typeof space !== 'function') {
      if (Array.isArray(expr)) {
        return expr.map(item => this.eval(item, { rng }));
      }
      if (typeof expr === 'object') {
        return Object.keys(expr)
          .reduce((r, key) => ({ ...r, [key]: this.eval(expr[key], { rng }) }), {});
      }
      return expr;
    }
    return space(rest, rng);
  };
}

export const STATUS_NEW = 'new';
export const STATUS_RUNNING = 'running';
export const STATUS_SUSPENDED = 'suspended';
export const STATUS_OK = 'ok';
export const STATUS_FAIL = 'fail';
export const STATUS_STRINGS = [
  'new', // computations have not started
  'running', // computations are in prog
  'suspended', // computations have been suspended, job is not finished
  'ok', // computations are finished, terminated normally
  'fail']; // computations are finished, terminated with error


// -- named constants for job execution pipeline
export const JOB_STATE_NEW = 0;
export const JOB_STATE_RUNNING = 1;
export const JOB_STATE_DONE = 2;
export const JOB_STATE_ERROR = 3;
export const JOB_STATES = [
  JOB_STATE_NEW,
  JOB_STATE_RUNNING,
  JOB_STATE_DONE,
  JOB_STATE_ERROR];


export const TRIAL_KEYS = [
  'id',
  'result',
  'args',
  'state',
  'book_time',
  'refresh_time',
];

export const range = (start, end) => Array.from({ length: (end - start) }, (v, k) => k + start);

export class Trials {
  constructor(expKey = null, refresh = true) {
    this.ids = [];
    this.dynamicTrials = [];
    this.trials = [];
    this.expKey = expKey;
    if (refresh) {
      this.refresh();
    }
  }

  get length() {
    return this.trials.length;
  }

  refresh = () => {
    if (this.expKey === null) {
      this.trials = this.dynamicTrials
        .filter(trial => trial.state !== JOB_STATE_ERROR);
    } else {
      this.trials = this.dynamicTrials
        .filter(trial => trial.state !== JOB_STATE_ERROR && trial.expKey === this.expKey);
      this.ids = [];
    }
  };

  get results() {
    return this.trials.map(trial => trial.result);
  }

  get args() {
    return this.trials.map(trial => trial.args);
  }

  assertValidTrial = (trial) => {
    if (Object.keys(trial).length <= 0) {
      throw new Error('trial should be an object');
    }
    const missingTrialKey = TRIAL_KEYS.find(key => trial[key] === undefined);
    if (missingTrialKey !== undefined) {
      throw new Error(`trial missing key ${missingTrialKey}`);
    }
    if (trial.expKey !== this.expKey) {
      throw new Error(`wrong trial expKey ${trial.expKey}, expected ${this.expKey}`);
    }
    return trial;
  };

  internalInsertTrialDocs = (docs) => {
    const rval = docs.map(doc => doc.id);
    this.dynamicTrials = [...this.dynamicTrials, ...docs];
    return rval;
  };

  insertTrialDoc = (trial) => {
    const doc = this.assertValidTrial(trial);
    return this.internalInsertTrialDocs([doc])[0];
  };

  insertTrialDocs = (trials) => {
    const docs = trials.map(trial => this.assertValidTrial(trial));
    return this.internalInsertTrialDocs(docs);
  };

  newTrialIds = (N) => {
    const aa = this.ids.length;
    const rval = range(aa, aa + N);
    this.ids = [...this.ids, ...rval];
    return rval;
  };

  newTrialDocs = (ids, results, args) => {
    const rval = [];
    for (let i = 0; i < ids.length; i += 1) {
      const doc = {
        state: JOB_STATE_NEW,
        id: ids[i],
        result: results[i],
        args: args[i],
      };
      doc.expKey = this.expKey;
      doc.book_time = null;
      doc.refresh_time = null;
      rval.push(doc);
    }
    return rval;
  };

  deleteAll = () => {
    this.dynamicTrials = [];
    this.refresh();
  };

  countByStateSynced = (arg, trials = null) => {
    const vTrials = trials === null ? this.trials : trials;
    const vArg = Array.isArray(arg) ? arg : [arg];
    const queue = vTrials.filter(doc => vArg.indexOf(doc.state) >= 0);
    return queue.length;
  };

  countByStateUnsynced = (arg) => {
    const expTrials = this.expKey !== null ?
      this.dynamicTrials.map(trial => trial.expKey === this.expKey) : this.dynamicTrials;
    return this.countByStateSynced(arg, expTrials);
  };

  losses = () => this.results.map(r => r.loss || r.accuracy);

  statuses = () => this.results.map(r => r.status);

  bestTrial(compare = (a, b) =>
    (a.loss !== undefined ? a.loss < b.loss : a.accuracy > b.accuracy)) {
    let best = this.trials[0];
    this.trials.forEach((trial) => {
      if (trial.result.status === STATUS_OK && compare(trial.result, best.result)) {
        best = trial;
      }
    });
    return best;
  }

  get argmin() {
    const best = this.bestTrial();
    return best !== undefined ? best.args : undefined;
  }

  get argmax() {
    const best = this.bestTrial((a, b) =>
      (a.loss !== undefined ? a.loss > b.loss : a.accuracy > b.accuracy));
    return best !== undefined ? best.args : undefined;
  }
}

export class Domain {
  constructor(fn, expr, params) {
    this.fn = fn;
    this.expr = expr;
    this.params = params;
  }

  evaluate = async (args) => {
    const rval = await this.fn(args, this.params);
    let result;
    if (typeof rval === 'number' && !Number.isNaN(rval)) {
      result = { loss: rval, status: STATUS_OK };
    } else {
      result = rval;
      if (result === undefined) {
        throw new Error('Optimization function should return a loss value');
      }
      const { status, loss, accuracy } = result;
      if (STATUS_STRINGS.indexOf(status) < 0) {
        throw new Error(`invalid status ${status}`);
      }
      if (status === STATUS_OK && loss === undefined && accuracy === undefined) {
        throw new Error('invalid loss and accuracy');
      }
    }
    return result;
  };
  newResult = () => ({
    status: STATUS_NEW,
  });
}
