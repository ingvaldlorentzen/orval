import {
  type GeneratorImport,
  type GeneratorMockOutput,
  type GeneratorMockOutputFull,
  OutputMockType,
} from '../types';
import { upath } from '../utils';

/**
 * Collapses the per-generator mock outputs for "inline" writer modes
 * (`single`, `tags`) where every mock generator's content is concatenated
 * into the implementation file. The MSW generator already emits the
 * response-factory functions (`get<Op>ResponseMock`) that Faker would emit,
 * so when both generators are configured we keep MSW and drop Faker to
 * avoid duplicate function declarations and re-imported faker bindings.
 */
export function collapseInlineMockOutputs<T extends { type: OutputMockType }>(
  mockOutputs: T[],
): T[] {
  const hasMsw = mockOutputs.some((m) => m.type === OutputMockType.MSW);
  if (!hasMsw) return mockOutputs;
  return mockOutputs.filter((m) => m.type !== OutputMockType.FAKER);
}

/**
 * Flattens a `GeneratorMockOutputFull` (which keeps `function` and `handler`
 * separate) into a `GeneratorMockOutput` by concatenating the two portions.
 */
export function flattenMockOutput(
  full: GeneratorMockOutputFull,
): GeneratorMockOutput {
  return {
    type: full.type,
    implementation: full.implementation.function + full.implementation.handler,
    imports: full.imports,
    strictMockSchemaTypeNames: full.strictMockSchemaTypeNames,
  };
}

// Handler call sites are always emitted argument-less (`get<Op>ResponseMock()`,
// see packages/mock/src/msw/index.ts), so an empty `()` is matched exactly.
const RESPONSE_MOCK_CALL_RE = /:\s*(get\w+ResponseMock\w*)\(\)/g;

/**
 * Strips the `function` portion (ResponseMock factories) from MSW mock outputs
 * so the `.msw.ts` file only contains handler code.
 *
 * When a Faker generator is also configured, the stripped functions live in
 * the `.faker.ts` file and the writer adds a cross-file import.
 *
 * When only MSW is configured, the ResponseMock fallback calls in handlers
 * are replaced with `undefined` so no faker dependency or import is needed.
 * The handler will return `HttpResponse.json(undefined)` when no override
 * is provided, which is a reasonable default for "no mock data" scenarios.
 *
 * The `faker` binding does not need to be removed here: it is injected during
 * import generation (`getMSWDependencies`) rather than carried on the output's
 * `imports`, and is pruned automatically once stripping removes every
 * `faker.*` call site.
 *
 * Operates on `GeneratorMockOutputFull` (before flattening) where
 * `function` and `handler` are still separate.
 */
export function collapseMswFakerFullOutputs(
  mockOutputs: GeneratorMockOutputFull[],
): GeneratorMockOutputFull[] {
  const hasMsw = mockOutputs.some((m) => m.type === OutputMockType.MSW);
  if (!hasMsw) return mockOutputs;

  const mswEntry = mockOutputs.find((m) => m.type === OutputMockType.MSW);
  if (!mswEntry || mswEntry.implementation.function.trim().length === 0)
    return mockOutputs;

  const hasFaker = mockOutputs.some((m) => m.type === OutputMockType.FAKER);

  if (!hasFaker) {
    const strippedHandler = mswEntry.implementation.handler.replaceAll(
      RESPONSE_MOCK_CALL_RE,
      ': undefined',
    );

    const strippedMsw: GeneratorMockOutputFull = {
      ...mswEntry,
      implementation: {
        function: '',
        handler: strippedHandler,
        handlerName: mswEntry.implementation.handlerName,
      },
    };

    return mockOutputs.map((m) =>
      m.type === OutputMockType.MSW ? strippedMsw : m,
    );
  }

  return mockOutputs.map((m) => {
    if (m.type !== OutputMockType.MSW) return m;

    return {
      ...m,
      implementation: {
        ...m.implementation,
        function: '',
      },
    };
  });
}

const RESPONSE_MOCK_NAME_RE = /\bget\w+ResponseMock\w*\b/g;

/**
 * Extracts the names of all `get<Op>ResponseMock` factory functions
 * referenced in a mock implementation string. Used by split-mode writers
 * to build cross-file imports from `.msw.ts` to `.faker.ts` so that
 * MSW handlers can call the response-factory functions defined in the
 * Faker output file.
 *
 * Matches names with optional status-code suffixes produced by
 * `generateEachHttpStatus` (e.g. `getListPetsResponseMock200`,
 * `getListPetsResponseMockDefault`).
 *
 * Returns deduplicated names in order of first occurrence.
 */
export function extractResponseMockNames(implementation: string): string[] {
  const names: string[] = [];
  let match: RegExpExecArray | null;
  const re = new RegExp(
    RESPONSE_MOCK_NAME_RE.source,
    RESPONSE_MOCK_NAME_RE.flags,
  );
  while ((match = re.exec(implementation)) !== null) {
    names.push(match[0]);
  }
  return [...new Set(names)];
}

/**
 * Builds cross-file `GeneratorImport` entries that allow an MSW mock file
 * to import the response-factory functions (`get<Op>ResponseMock`) from
 * the corresponding Faker mock file.
 *
 * Imports exactly the factory names the MSW handler actually references
 * (`mswImplementation`), intersected with the names the Faker file actually
 * exports (`fakerImplementation`). Deriving from the consumer keeps the import
 * list in lock-step with the handler — it can never import a factory the
 * handler does not call (unused-import lint error) nor miss one it does call
 * (broken reference). The intersection guards against importing a name the
 * Faker file does not declare.
 *
 * Returns an empty array when the handler references no response factories
 * (e.g. an MSW-only output already stripped to `undefined`).
 */
export function buildCrossFileFakerImports(
  mswFilePath: string,
  fakerFilePath: string,
  mswImplementation: string,
  fakerImplementation: string,
): GeneratorImport[] {
  const referencedNames = extractResponseMockNames(mswImplementation);
  if (referencedNames.length === 0) return [];

  const declaredNames = new Set(extractResponseMockNames(fakerImplementation));
  const responseMockNames = referencedNames.filter((name) =>
    declaredNames.has(name),
  );
  if (responseMockNames.length === 0) return [];

  const fakerImportPath = upath.getRelativeImportPath(
    mswFilePath,
    fakerFilePath,
  );

  return responseMockNames.map(
    (name): GeneratorImport => ({
      name,
      values: true,
      importPath: fakerImportPath,
    }),
  );
}
