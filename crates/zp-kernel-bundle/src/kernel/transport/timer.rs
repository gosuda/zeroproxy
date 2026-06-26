//! SW `setTimeout`-backed delay future + a future/deadline race helper.
//!
//! WASM has no std clock or timer; inside a Service Worker the only timing
//! primitive is the global `setTimeout`. We wrap one one-shot timer in a
//! `Future` so transport code can race a request against a deadline.
//!
//! ## Why the transport needs this
//!
//! The very first request on a freshly-opened yamux session (the page's
//! main document) intermittently stalls ~60s: the response bytes arrive but
//! the cold-bootstrap wakeup is lost until an unrelated keepalive ping pumps
//! the loop — OR an upstream anti-bot slow-lane holds the first stream.
//! Either way a fresh retry on a new h2 connection clears it in <1s. The
//! cold path in `fetch` races the request against [`with_timeout`] and
//! retries on a fresh connection when the deadline fires.
//!
//! Timer fidelity: a SW `setTimeout` is coarse (clamped, throttled when the
//! worker is backgrounded), but we only need second-scale deadlines, so the
//! coarseness is irrelevant.

use std::cell::RefCell;
use std::pin::Pin;
use std::rc::Rc;
use std::task::{Context, Poll, Waker};

use wasm_bindgen::closure::Closure;
use wasm_bindgen::JsCast;

struct TimerState {
    fired: bool,
    waker: Option<Waker>,
}

/// One-shot timer future. Resolves `()` after roughly `ms` milliseconds.
/// Dropping it before it fires cancels the underlying `setTimeout` so a
/// cancelled race never leaves a callback firing into freed state.
pub(crate) struct Timeout {
    state: Rc<RefCell<TimerState>>,
    // Keep the JS closure alive for the timer's lifetime; dropped with self.
    _closure: Closure<dyn FnMut()>,
    handle: i32,
    global: web_sys::WorkerGlobalScope,
}

impl Timeout {
    pub(crate) fn new(ms: f64) -> Self {
        let state = Rc::new(RefCell::new(TimerState {
            fired: false,
            waker: None,
        }));
        let cb_state = state.clone();
        let closure = Closure::wrap(Box::new(move || {
            // Take the waker out and RELEASE the borrow before waking. Waking
            // can re-enter the executor; holding the RefCell borrow across the
            // wake risks a re-entrant borrow panic.
            let waker = {
                let mut s = cb_state.borrow_mut();
                s.fired = true;
                s.waker.take()
            };
            if let Some(w) = waker {
                w.wake();
            }
        }) as Box<dyn FnMut()>);
        // In a Service Worker `self` is a ServiceWorkerGlobalScope, which
        // extends WorkerGlobalScope — the cast is always valid here.
        let global: web_sys::WorkerGlobalScope = js_sys::global().unchecked_into();
        let handle = global
            .set_timeout_with_callback_and_timeout_and_arguments_0(
                closure.as_ref().unchecked_ref(),
                ms.max(0.0) as i32,
            )
            .unwrap_or(0);
        Timeout {
            state,
            _closure: closure,
            handle,
            global,
        }
    }
}

impl Drop for Timeout {
    fn drop(&mut self) {
        // Cancel any still-pending timer. Harmless if it already fired.
        self.global.clear_timeout_with_handle(self.handle);
    }
}

impl std::future::Future for Timeout {
    type Output = ();
    fn poll(self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<()> {
        let mut s = self.state.borrow_mut();
        if s.fired {
            return Poll::Ready(());
        }
        s.waker = Some(cx.waker().clone());
        Poll::Pending
    }
}

/// Outcome of [`with_timeout`].
pub(crate) enum Raced<T> {
    /// The inner future completed first; carries its output.
    Done(T),
    /// The deadline fired first; the inner future was dropped (cancelled).
    TimedOut,
}

/// Race `fut` against a `ms`-millisecond deadline. If `fut` resolves first
/// we return `Raced::Done` with its output; otherwise `Raced::TimedOut` and
/// `fut` is dropped — for our transport futures that means the h2 stream /
/// TLS conn drops, sending RST and freeing the upstream stream.
pub(crate) async fn with_timeout<F>(fut: F, ms: f64) -> Raced<F::Output>
where
    F: std::future::Future,
{
    use futures::future::{select, Either};
    futures::pin_mut!(fut);
    let timeout = Timeout::new(ms);
    futures::pin_mut!(timeout);
    match select(fut, timeout).await {
        Either::Left((out, _timeout)) => Raced::Done(out),
        Either::Right(((), _fut)) => Raced::TimedOut,
    }
}
