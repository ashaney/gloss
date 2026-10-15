-- Gloss: the local reader's shelf, marks and notes, mirrored from the browser.
-- Every synced table has the same shape so one sync route serves them all:
-- rows are owned by the single local user id, carry the client's object as jsonb, and
-- are never hard-deleted by the app (a tombstone tells other devices).
-- Safe to run more than once.

create table if not exists articles (
  user_id text not null,
  id text not null,
  article_id text not null,
  data jsonb not null,          -- the shelf entry: title, author, words, origin
  doc jsonb,                    -- the full text; null for bundled samples and tombstones
  deleted boolean not null default false,
  updated_at timestamptz not null default now(),
  primary key (user_id, id)
);

create table if not exists highlights (
  user_id text not null,
  id text not null,
  article_id text not null,
  data jsonb not null,          -- anchor (with quote), colour, createdAt
  deleted boolean not null default false,
  updated_at timestamptz not null default now(),
  primary key (user_id, id)
);

create table if not exists glosses (
  user_id text not null,
  id text not null,
  article_id text not null,
  data jsonb not null,          -- anchor or position, action, question, turns
  deleted boolean not null default false,
  updated_at timestamptz not null default now(),
  primary key (user_id, id)
);

create table if not exists briefs (
  user_id text not null,
  id text not null,             -- the article id: one per text
  article_id text not null,
  data jsonb not null,
  deleted boolean not null default false,
  updated_at timestamptz not null default now(),
  primary key (user_id, id)
);

create table if not exists progress (
  user_id text not null,
  id text not null,             -- the article id: one per text
  article_id text not null,
  data jsonb not null,
  deleted boolean not null default false,
  updated_at timestamptz not null default now(),
  primary key (user_id, id)
);

create index if not exists articles_user_updated on articles (user_id, updated_at);
create index if not exists highlights_user_updated on highlights (user_id, updated_at);
create index if not exists glosses_user_updated on glosses (user_id, updated_at);
create index if not exists briefs_user_updated on briefs (user_id, updated_at);
create index if not exists progress_user_updated on progress (user_id, updated_at);


-- Covers painted for the reader's texts (opt-in), so other devices fetch them
create table if not exists covers (
  user_id text not null,
  id text not null,             -- the article id
  jpeg text not null,
  created_at timestamptz not null default now(),
  primary key (user_id, id)
);

-- Tokens that let the reader's agent (Grok Bot, Claude, ...) save to their library through /mcp.
-- Only a hash of each token is kept; the token itself is shown once, when it is made.
create table if not exists agent_tokens (
  id text primary key,
  user_id text not null,
  hash text not null unique,
  label text not null default '',
  created_at timestamptz not null default now(),
  last_used_at timestamptz,
  revoked boolean not null default false
);

create index if not exists agent_tokens_user on agent_tokens (user_id);
