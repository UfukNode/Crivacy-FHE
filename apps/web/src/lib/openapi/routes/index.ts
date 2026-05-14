/**
 * Top-level routes barrel. Importing this module is the single call
 * needed to populate the shared OpenAPI registry with every path the
 * API exposes. `build-spec.ts` and the test suite both import this
 * module to trigger registration before reading `registry.definitions`.
 */

import './admin';
import './internal';
import './public';
import './webhooks';
