-- Run this in your Supabase SQL editor

create table if not exists doorbell_events (
  id          bigint generated always as identity primary key,
  category    text    not null,
  confidence  float   not null,
  carrier     text,
  details     text,
  camera_name text,
  detected_at timestamptz default now()
);

create index if not exists idx_doorbell_category_time
  on doorbell_events(category, detected_at desc);

-- Optional: enable RLS (set to your user if needed)
-- alter table doorbell_events enable row level security;
