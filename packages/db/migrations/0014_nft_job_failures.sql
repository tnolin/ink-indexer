-- Consecutive failed OpenSea requests per collection and job, for the back-off between retries.
-- A row exists only while a job is failing; a success deletes it.
create table indexer.nft_job_failures (
  contract text not null,
  job text not null,
  failures int not null,
  primary key (contract, job)
);
