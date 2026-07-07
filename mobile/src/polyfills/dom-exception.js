const DOM_EXCEPTION_CODES = {
  IndexSizeError: 1,
  DOMStringSizeError: 2,
  HierarchyRequestError: 3,
  WrongDocumentError: 4,
  InvalidCharacterError: 5,
  NoDataAllowedError: 6,
  NoModificationAllowedError: 7,
  NotFoundError: 8,
  NotSupportedError: 9,
  InUseAttributeError: 10,
  InvalidStateError: 11,
  SyntaxError: 12,
  InvalidModificationError: 13,
  NamespaceError: 14,
  InvalidAccessError: 15,
  ValidationError: 16,
  TypeMismatchError: 17,
  SecurityError: 18,
  NetworkError: 19,
  AbortError: 20,
  URLMismatchError: 21,
  QuotaExceededError: 22,
  TimeoutError: 23,
  InvalidNodeTypeError: 24,
  DataCloneError: 25,
};

class ReactNativeDOMException extends Error {
  constructor(message = '', name = 'Error') {
    super(message);
    this.name = name;
    this.code = DOM_EXCEPTION_CODES[name] ?? 0;
  }
}

for (const [name, code] of Object.entries(DOM_EXCEPTION_CODES)) {
  Object.defineProperty(ReactNativeDOMException, name, {
    configurable: false,
    enumerable: true,
    value: code,
    writable: false,
  });
  Object.defineProperty(ReactNativeDOMException.prototype, name, {
    configurable: false,
    enumerable: true,
    value: code,
    writable: false,
  });
}

if (typeof globalThis.DOMException === 'undefined') {
  Object.defineProperty(globalThis, 'DOMException', {
    configurable: true,
    value: ReactNativeDOMException,
    writable: true,
  });
}
