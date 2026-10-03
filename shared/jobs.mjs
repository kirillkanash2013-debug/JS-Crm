// Legacy jobs without kind are collections; writes/validation/imports never are.
export const isCollectionJob=job=>!!job&&!job.action&&(job.kind||'collection')==='collection';
