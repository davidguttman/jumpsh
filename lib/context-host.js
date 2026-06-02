import crypto from 'crypto';

const DNS_LABEL_MAX_LENGTH = 63;
const CONTEXT_HOST_HASH_LENGTH = 16;

function hashContextHost(rawLabel) {
  return crypto
    .createHash('sha256')
    .update(rawLabel)
    .digest('hex')
    .slice(0, CONTEXT_HOST_HASH_LENGTH);
}

function splitReadableBudget(projectSubdomain, contextSubdomain, budget) {
  const delimiterLength = 2;
  const partBudget = Math.max(0, budget - delimiterLength);
  let projectBudget = Math.ceil(partBudget / 2);
  let contextBudget = partBudget - projectBudget;

  if (projectSubdomain.length < projectBudget) {
    contextBudget += projectBudget - projectSubdomain.length;
    projectBudget = projectSubdomain.length;
  }

  if (contextSubdomain.length < contextBudget) {
    projectBudget += contextBudget - contextSubdomain.length;
    contextBudget = contextSubdomain.length;
  }

  projectBudget = Math.min(projectBudget, projectSubdomain.length);
  contextBudget = Math.min(contextBudget, contextSubdomain.length);

  return { projectBudget, contextBudget };
}

/**
 * Encode a context host label for project links.
 *
 * Normal context labels stay as project--context. When that first DNS label
 * would exceed 63 characters, keep a readable project/context prefix and add a
 * stable hash suffix so the proxy can deterministically resolve it by
 * recomputing aliases for known project/context pairs.
 */
function getContextHostMetadata(projectSubdomain, contextSubdomain) {
  const project = String(projectSubdomain || '');
  const context = String(contextSubdomain || '');
  const rawLabel = `${project}--${context}`;

  if (rawLabel.length <= DNS_LABEL_MAX_LENGTH) {
    return {
      label: rawLabel,
      rawLabel,
      rawLength: rawLabel.length,
      isShortened: false,
    };
  }

  const hash = hashContextHost(rawLabel);
  const hashSuffix = `--${hash}`;
  const readableBudget = DNS_LABEL_MAX_LENGTH - hashSuffix.length;
  const { projectBudget, contextBudget } = splitReadableBudget(project, context, readableBudget);
  const readablePrefix = `${project.slice(0, projectBudget)}--${context.slice(0, contextBudget)}`;
  const label = `${readablePrefix}${hashSuffix}`;

  return {
    label,
    rawLabel,
    rawLength: rawLabel.length,
    isShortened: true,
  };
}

function contextHostWouldShorten(projectSubdomain, contextSubdomain) {
  return getContextHostMetadata(projectSubdomain, contextSubdomain).isShortened;
}

function encodeContextHost(projectSubdomain, contextSubdomain) {
  return getContextHostMetadata(projectSubdomain, contextSubdomain).label;
}

export { DNS_LABEL_MAX_LENGTH, contextHostWouldShorten, encodeContextHost, getContextHostMetadata };
