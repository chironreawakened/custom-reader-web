-- Custom Reader - schema: app.users, app.storage_objects (slice 0)
create schema if not exists "app";

create table "app"."users" (
    "id" uuid primary key not null,
    "email" varchar(255) not null unique,
    "created_at" timestamp with time zone default now() not null
);

create table "app"."storage_objects" (
    "id" uuid primary key not null,
    "user_id" uuid not null references "app"."users"("id") on delete cascade,
    "wrapped_dek" text not null,
    "key_version" integer default 1 not null,
    "plain_size" integer not null,
    "mime" varchar(127) default 'application/octet-stream' not null,
    "created_at" timestamp with time zone default now() not null
);

alter table "app"."storage_objects" add constraint "storage_objects_user_id_users_id_fk"
    foreign key ("user_id") references "app"."users"("id") on delete cascade on update cascade;
