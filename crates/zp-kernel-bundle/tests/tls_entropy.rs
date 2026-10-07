// The GREASE draws and the ECH GREASE noise start from entropy the kernel gives them at boot (`kernelSetCapturedSpec`).
// Before that they started from a constant, so the FIRST ClientHello after every worker start was the same for every user.
use rustls::ja3::{is_grease_value, random_bytes, random_grease, seed_entropy};

// The generators are thread-local: each spawned thread starts from the unseeded state.
fn on_fresh_thread<T: Send + 'static>(f: impl FnOnce() -> T + Send + 'static) -> T {
    std::thread::spawn(f).join().unwrap()
}

#[test]
fn seeding_changes_the_grease_sequence() {
    let unseeded = on_fresh_thread(|| (0..8).map(|_| random_grease()).collect::<Vec<_>>());
    assert_eq!(unseeded, on_fresh_thread(|| (0..8).map(|_| random_grease()).collect::<Vec<_>>()), "the unseeded start is a constant");
    let seeded = on_fresh_thread(|| {
        seed_entropy(0x1234_5678_9abc_def0);
        (0..8).map(|_| random_grease()).collect::<Vec<_>>()
    });
    assert_ne!(unseeded, seeded);
    assert!(seeded.iter().all(|v| is_grease_value(*v)));
}

#[test]
fn different_seeds_give_different_ech_noise_and_one_seed_repeats() {
    let bytes = |seed: u64| on_fresh_thread(move || {
        seed_entropy(seed);
        random_bytes(48)
    });
    let (a, b) = (bytes(1), bytes(2));
    assert_eq!(a.len(), 48);
    assert_ne!(a, b);
    assert_eq!(a, bytes(1));
    assert_ne!(a, on_fresh_thread(|| random_bytes(48)), "unseeded noise is the constant every installation shared");
}

#[test]
fn a_zero_seed_does_not_stall_the_generators() {
    let (noise, g1, g2) = on_fresh_thread(|| {
        seed_entropy(0);
        (random_bytes(16), random_grease(), random_grease())
    });
    assert!(noise.iter().any(|b| *b != 0));
    assert!(is_grease_value(g1) && is_grease_value(g2));
}
