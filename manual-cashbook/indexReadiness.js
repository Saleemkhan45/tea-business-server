export const sameKey = (left, right) => JSON.stringify(left) === JSON.stringify(right)
export const compatibleIndex = (index, expected) => sameKey(index.key, expected.key) && index.unique === true && !index.sparse && !index.partialFilterExpression && index.expireAfterSeconds === undefined && (!index.collation || index.collation.locale === 'simple')
export function inspectIndexes(indexes, expected) {
  return {
    missing: expected.filter(required => !indexes.some(index => compatibleIndex(index, required))),
    conflicts: indexes.filter(index => index.expireAfterSeconds !== undefined || (!sameKey(index.key, { _id: 1 }) && (index.unique || expected.some(required => sameKey(index.key, required.key))) && !expected.some(required => compatibleIndex(index, required)))),
  }
}
