const assert = require("assert");
const removeSlash = require("remove-trailing-slash");
const looselyValidate = require("@segment/loosely-validate-event");
const serialize = require("serialize-javascript");
const Queue = require("bull");
const axios = require("axios");
const axiosRetry = require("axios-retry");
const ms = require("ms");
const uuid = require("uuid/v4");
const md5 = require("md5");
const isString = require("lodash.isstring");
const version = require("./package.json").version;

const setImmediate = global.setImmediate || process.nextTick.bind(process);
const noop = () => {};

class Analytics {
  /**
   * Initialize a new `Analytics` with your Segment project's `writeKey` and an
   * optional dictionary of `options`.
   *
   * @param {String} writeKey
   * @param {Object} [options] (optional)
   *   @property {Number} flushAt (default: 20)
   *   @property {Number} flushInterval (default: 10000)
   *   @property {String} host (default: required)
   *   @property {Boolean} enable (default: true)
   */

  constructor(writeKey, dataPlaneURL, options) {
    options = options || {};

    assert(writeKey, "You must pass your project's write key.");
    assert(dataPlaneURL, "You must pass your data plane url.");

    this.queue = [];
    this.pQueue = undefined;
    this.pQueueOpts = undefined;
    this.state = "idle";
    this.writeKey = writeKey;
    this.host = removeSlash(dataPlaneURL);
    this.timeout = options.timeout || false;
    this.flushAt = Math.max(options.flushAt, 1) || 20;
    this.flushInterval = options.flushInterval || 20000;
    this.maxInternalQueueSize = options.maxInternalQueueSize || 20000;
    this.flushed = false;
    Object.defineProperty(this, "enable", {
      configurable: false,
      writable: false,
      enumerable: true,
      value: typeof options.enable === "boolean" ? options.enable : true
    });

    axiosRetry(axios, { retries: 0 });
  }

  /**
   *
   * @param {*} queueOpts
   * {
   *    queueName: string = rudderEventsQueue,
   *    prefix: string = rudder
   *    redisOpts: {
   *      port?: number = 6379;
   *      host?: string = localhost;
   *      db?: number = 0;
   *      password?: string;
   *    },
   *    jobOpts: {
   *      maxAttempts: number = 10
   *    }
   * }
   * @param {*} callback
   *  All error paths from redis and queue will give exception, so they are non-retryable from SDK perspective
   *  The queue may not function for unhandled promise rejections
   *  this error callback is called when the SDK wants the user to retry
   */
  createPersistenceQueue(queueOpts, callback) {
    if (this.pQueue) {
      console.log("a persistent queue is already initialized, skipping...");
      return;
    }
    try {
      this.pQueueOpts = queueOpts || {};
      if (!this.pQueueOpts.redisOpts) {
        throw new Error(
          "redis connection parameters not present. Cannot make a persistent queue"
        );
      }
      this.pJobOpts = this.pQueueOpts.jobOpts || {};
      this.pQueue = new Queue(
        this.pQueueOpts.queueName || "rudderEventsQueue",
        {
          redis: this.pQueueOpts.redisOpts,
          prefix: this.pQueueOpts.prefix || "rudder"
        }
      );
    } catch (error) {
      callback(error);
    }

    if (this.pQueue) {
      const _isErrorRetryable = this._isErrorRetryable;
      const rdone = (callbacks, err) => {
        callbacks.forEach(callback_ => {
          callback_(err);
        });
      };

      const payloadQueue = this.pQueue;
      const jobOpts = this.pJobOpts;

      this.pQueue.on("failed", function(job, error) {
        let jobData = eval("(" + job.data.eventData + ")");
        console.log("job : " + jobData.description + " " + error);
      });

      // tapping on queue events
      this.pQueue.on("completed", function(job, result) {
        let jobData = eval("(" + job.data.eventData + ")");
        result = result || "completed";
        console.log("job : " + jobData.description + " " + result);
      });

      this.pQueue.on("stalled", function(job) {
        let jobData = eval("(" + job.data.eventData + ")");
        console.log("job : " + jobData.description + " is stalled...");
      });
      // at startup get active job, remove it, then add it in front of queue to retried first
      // then add the queue processor
      this.pQueue
        .getActive()
        .then(jobs => {
          console.log("success geting active jobs");
          if (jobs.length == 0) {
            console.log("there are no active jobs while starting up queue");
            payloadQueue.process(function(job, done) {
              // job failed for maxAttempts or more times, push to failed queue
              // starting with attempt = 0
              let maxAttempts = jobOpts.maxAttempts || 10;
              let jobData = eval("(" + job.data.eventData + ")");
              if (jobData.attempts >= maxAttempts) {
                done(
                  new Error(
                    "job : " +
                      jobData.description +
                      " pushed to failed queue after attempts " +
                      jobData.attempts +
                      " skipping further retries..."
                  )
                );
              } else {
                // process the job after exponential delay, if it's the 0th attempt, setTimeout will fire immediately
                // max delay is 30 sec, it is mostly in sync with a bull queue job max lock time
                setTimeout(function() {
                  let req = jobData.request;
                  req.data.sentAt = new Date();
                  // if request succeeded, mark the job done and move to completed
                  axios(req)
                    .then(response => {
                      rdone(jobData.callbacks);
                      done();
                    })
                    .catch(err => {
                      // check if request is retryable
                      if (_isErrorRetryable(err)) {
                        let attempts = jobData.attempts;
                        jobData.attempts = attempts + 1;
                        // increment attempt
                        // add a new job to queue in lifo
                        // if able to add, mark the earlier job done with push to completed with a msg
                        // if add to redis queue gives exception, not catching it
                        // in case of redis queue error, mark the job as failed ? i.e add the catch block in below promise ?
                        payloadQueue
                          .add(
                            { eventData: serialize(jobData) },
                            { lifo: true }
                          )
                          .then(pushedJob => {
                            done(
                              null,
                              "job : " +
                                jobData.description +
                                " failed for attempt " +
                                attempts +
                                " " +
                                err
                            );
                          });
                      } else {
                        // if not retryable, mark the job failed and to failed queue for user to retry later
                        rdone(jobData.callbacks);
                        done(err);
                      }
                    });
                }, Math.min(30000, Math.pow(2, jobData.attempts) * 1000));
              }
            });
            console.log("success adding process");
            callback();
          } else {
            // since there is only once process, the count of active jobs will be 1 at max
            // moving active job is important as this job doesn't have a process function
            // and will later be retried which will mess event ordering
            if (jobs.length > 1) {
              console.log("number of active jobs at starting up queue > 1 ");
              callback(
                new Error(
                  "queue has more than 1 active job, move them to failed and try again"
                )
              );
            }
            console.log("number of active jobs at starting up queue =  1 ");
            jobs.forEach(job => {
              job
                .remove()
                .then(() => {
                  console.log("success removed active job");
                  let jobData = eval("(" + job.data.eventData + ")");
                  jobData.attempts = 0;
                  payloadQueue
                    .add({ eventData: serialize(jobData) }, { lifo: true })
                    .then(removedJob => {
                      console.log("success adding removed job back to queue");
                      payloadQueue.process(function(job, done) {
                        let maxAttempts = jobOpts.maxAttempts || 10;
                        let jobData = eval("(" + job.data.eventData + ")");
                        if (jobData.attempts >= maxAttempts) {
                          done(
                            new Error(
                              "job : " +
                                jobData.description +
                                " pushed to failed queue after attempts " +
                                jobData.attempts +
                                " skipping further retries..."
                            )
                          );
                        } else {
                          // process the job after exponential delay, if it's the 0th attempt, setTimeout will fire immediately
                          setTimeout(function() {
                            let req = jobData.request;
                            req.data.sentAt = new Date();
                            axios(req)
                              .then(response => {
                                rdone(jobData.callbacks);
                                done();
                              })
                              .catch(err => {
                                if (_isErrorRetryable(err)) {
                                  let attempts = jobData.attempts;
                                  jobData.attempts = attempts + 1;
                                  payloadQueue
                                    .add(
                                      { eventData: serialize(jobData) },
                                      { lifo: true }
                                    )
                                    .then(pushedJob => {
                                      done(
                                        null,
                                        "job : " +
                                          jobData.description +
                                          " failed for attempt " +
                                          attempts +
                                          " " +
                                          err
                                      );
                                    });
                                } else {
                                  rdone(jobData.callbacks);
                                  done(err);
                                }
                              });
                          }, Math.min(
                            30000,
                            Math.pow(2, jobData.attempts) * 1000
                          ));
                        }
                      });
                      console.log("success adding process");
                      callback();
                    });
                })
                .catch(error => {
                  console.log("failed to remove active job");
                  callback(error);
                });
            });
          }
        })
        .catch(error => {
          console.log("failed geting active jobs");
          callback(error);
        });
    }
  }

  _validate(message, type) {
    try {
      looselyValidate(message, type);
    } catch (e) {
      if (e.message === "Your message must be < 32kb.") {
        console.log(
          "Your message must be < 32kb. This is currently surfaced as a warning to allow clients to update. Versions released after August 1, 2018 will throw an error instead. Please update your code before then.",
          message
        );
        return;
      }
      throw e;
    }
  }

  /**
   * Send an identify `message`.
   *
   * @param {Object} message
   * @param {Function} [callback] (optional)
   * @return {Analytics}
   */

  identify(message, callback) {
    this._validate(message, "identify");
    this.enqueue("identify", message, callback);
    return this;
  }

  /**
   * Send a group `message`.
   *
   * @param {Object} message
   * @param {Function} [callback] (optional)
   * @return {Analytics}
   */

  group(message, callback) {
    this._validate(message, "group");
    this.enqueue("group", message, callback);
    return this;
  }

  /**
   * Send a track `message`.
   *
   * @param {Object} message
   * @param {Function} [callback] (optional)
   * @return {Analytics}
   */

  track(message, callback) {
    this._validate(message, "track");
    this.enqueue("track", message, callback);
    return this;
  }

  /**
   * Send a page `message`.
   *
   * @param {Object} message
   * @param {Function} [callback] (optional)
   * @return {Analytics}
   */

  page(message, callback) {
    this._validate(message, "page");
    this.enqueue("page", message, callback);
    return this;
  }

  /**
   * Send a screen `message`.
   *
   * @param {Object} message
   * @param {Function} fn (optional)
   * @return {Analytics}
   */

  screen(message, callback) {
    this._validate(message, "screen");
    this.enqueue("screen", message, callback);
    return this;
  }

  /**
   * Send an alias `message`.
   *
   * @param {Object} message
   * @param {Function} [callback] (optional)
   * @return {Analytics}
   */

  alias(message, callback) {
    this._validate(message, "alias");
    this.enqueue("alias", message, callback);
    return this;
  }

  /**
   * Add a `message` of type `type` to the queue and
   * check whether it should be flushed.
   *
   * @param {String} type
   * @param {Object} message
   * @param {Function} [callback] (optional)
   * @api private
   */

  enqueue(type, message, callback) {
    if (this.queue.length >= this.maxInternalQueueSize) {
      console.log(
        "not adding events for processing as queue size " +
          this.queue.length +
          " >= than max configuration " +
          this.maxInternalQueueSize
      );
      return;
    }
    callback = callback || noop;

    if (!this.enable) {
      return setImmediate(callback);
    }

    if (type == "identify") {
      if (message.traits) {
        if (!message.context) {
          message.context = {};
        }
        message.context.traits = message.traits;
      }
    }

    message = { ...message };
    message.type = type;

    message.context = {
      library: {
        name: "analytics-node",
        version
      },
      ...message.context
    };

    message._metadata = {
      nodeVersion: process.versions.node,
      ...message._metadata
    };

    if (!message.originalTimestamp) {
      message.originalTimestamp = new Date();
    }

    if (!message.messageId) {
      // We md5 the messaage to add more randomness. This is primarily meant
      // for use in the browser where the uuid package falls back to Math.random()
      // which is not a great source of randomness.
      // Borrowed from analytics.js (https://github.com/segment-integrations/analytics.js-integration-segmentio/blob/a20d2a2d222aeb3ab2a8c7e72280f1df2618440e/lib/index.js#L255-L256).
      message.messageId = `node-${md5(JSON.stringify(message))}-${uuid()}`;
    }

    // Historically this library has accepted strings and numbers as IDs.
    // However, our spec only allows strings. To avoid breaking compatibility,
    // we'll coerce these to strings if they aren't already.
    if (message.anonymousId && !isString(message.anonymousId)) {
      message.anonymousId = JSON.stringify(message.anonymousId);
    }
    if (message.userId && !isString(message.userId)) {
      message.userId = JSON.stringify(message.userId);
    }

    this.queue.push({ message, callback });

    if (!this.flushed) {
      this.flushed = true;
      this.flush();
      return;
    }

    if (this.queue.length >= this.flushAt) {
      this.flush();
    }

    if (this.flushInterval && !this.timer) {
      this.timer = setTimeout(this.flush.bind(this), this.flushInterval);
    }
  }

  /**
   * Flush the current queue
   *
   * @param {Function} [callback] (optional)
   * @return {Analytics}
   */

  flush(callback) {
    // check if earlier flush was pushed to queue
    if (this.state == "running") {
      return;
    }
    this.state = "running";
    callback = callback || noop;

    if (!this.enable) {
      return setImmediate(callback);
    }

    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }

    if (!this.queue.length) {
      return setImmediate(callback);
    }

    const items = this.queue.slice(0, this.flushAt);
    const callbacks = items.map(item => item.callback);
    //console.log("callbacks:: " + callbacks);
    const messages = items.map(item => {
      // if someone mangles directly with queue
      if (typeof item.message == "object") {
        item.message.sentAt = new Date();
      }
      return item.message;
    });

    const data = {
      batch: messages,
      sentAt: new Date()
    };

    // console.log("===data===", data);

    const done = err => {
      callbacks.forEach(callback_ => {
        callback_(err);
      });
      callback(err, data);
    };

    // Don't set the user agent if we're not on a browser. The latest spec allows
    // the User-Agent header (see https://fetch.spec.whatwg.org/#terminology-headers
    // and https://developer.mozilla.org/en-US/docs/Web/API/XMLHttpRequest/setRequestHeader),
    // but browsers such as Chrome and Safari have not caught up.
    const headers = {};
    if (typeof window === "undefined") {
      headers["user-agent"] = `analytics-node/${version}`;
    }

    const req = {
      method: "POST",
      url: `${this.host}`,
      auth: {
        username: this.writeKey
      },
      data,
      headers
    };

    if (this.timeout) {
      req.timeout =
        typeof this.timeout === "string" ? ms(this.timeout) : this.timeout;
    }

    if (this.pQueue) {
      let eventData = {
        description: `node-${md5(JSON.stringify(req))}-${uuid()}`,
        request: req,
        callbacks: callbacks,
        attempts: 0
      };
      // using serialize library as default JSON.stringify mangles with function/callback serialization
      this.pQueue
        .add({ eventData: serialize(eventData) })
        .then(pushedJob => {
          this.queue.splice(0, this.flushAt);
          this.state = "idle";
        })
        .catch(error => {
          console.log(
            "failed to push to redis queue, in-memory queue size: " +
              this.queue.length
          );
          throw error;
        });
    } else {
      axios({
        ...req,
        "axios-retry": {
          retries: 3,
          retryCondition: this._isErrorRetryable,
          retryDelay: axiosRetry.exponentialDelay
        }
      })
        .then(response => {
          this.queue.splice(0, this.flushAt);
          this.state = "idle";
          done();
        })
        .catch(err => {
          this.queue.splice(0, this.flushAt);
          this.state = "idle";
          if (err.response) {
            const error = new Error(err.response.statusText);
            return done(error);
          }
          done(err);
        });
    }
  }

  _isErrorRetryable(error) {
    // Retry Network Errors.
    if (axiosRetry.isNetworkError(error)) {
      return true;
    }

    if (!error.response) {
      // Cannot determine if the request can be retried
      return false;
    }

    // Retry Server Errors (5xx).
    if (error.response.status >= 500 && error.response.status <= 599) {
      return true;
    }

    // Retry if rate limited.
    if (error.response.status === 429) {
      return true;
    }

    return false;
  }
}

module.exports = Analytics;
