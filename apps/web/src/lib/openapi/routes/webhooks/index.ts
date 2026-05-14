/**
 * Inbound webhook route barrel. Importing this module triggers
 * side-effect registration of every upstream-provider webhook path
 * (currently only Didit) in the shared OpenAPI registry.
 */

import './didit';
