create table items (
  id serial primary key,
  title text not null,
  created_at timestamptz not null default now()
);
