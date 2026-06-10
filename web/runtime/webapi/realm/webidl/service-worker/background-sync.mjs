const backgroundInterfaceNames = Object.freeze([
  'BackgroundFetchManager',
  'BackgroundFetchRecord',
  'BackgroundFetchRegistration',
  'PushManager',
  'PushSubscription',
  'PushSubscriptionOptions',
  'SyncManager',
  'PeriodicSyncManager',
]);

export function createBackgroundServiceFacades() {
  return Object.fromEntries(backgroundInterfaceNames.map((name) => [name, makeIllegalConstructor(name)]));
}

function makeIllegalConstructor(name) {
  const ctor = function BackgroundServiceConstructor() {
    throw new TypeError("Failed to construct '" + name + "': Illegal constructor");
  };
  Object.defineProperty(ctor, 'name', { value: name, configurable: true });
  Object.defineProperty(ctor.prototype, Symbol.toStringTag, { value: name, configurable: true });
  return ctor;
}
