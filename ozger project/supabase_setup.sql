-- SQL скрипт для настройки таблиц в Supabase
-- Выполните этот скрипт в Supabase SQL Editor

-- Создание таблицы auth_audit для хранения username-email соответствий
CREATE TABLE IF NOT EXISTS auth_audit (
    id SERIAL PRIMARY KEY,
    username TEXT UNIQUE NOT NULL,
    email TEXT UNIQUE NOT NULL,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Создание таблицы profiles для хранения полных профилей пользователей
CREATE TABLE IF NOT EXISTS profiles (
    id UUID REFERENCES auth.users(id) ON DELETE CASCADE PRIMARY KEY,
    username TEXT UNIQUE,
    email TEXT,
    country TEXT,
    city TEXT,
    school TEXT,
    class TEXT,
    class_digit INTEGER,
    class_symbol TEXT,
    subject_combination TEXT,
    subject1 TEXT,
    subject2 TEXT,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Включение Row Level Security
ALTER TABLE auth_audit ENABLE ROW LEVEL SECURITY;
ALTER TABLE profiles ENABLE ROW LEVEL SECURITY;

-- Политики безопасности для auth_audit
CREATE POLICY "Users can view their own audit data" ON auth_audit
    FOR SELECT USING (auth.uid() IS NOT NULL);

CREATE POLICY "Users can insert their own audit data" ON auth_audit
    FOR INSERT WITH CHECK (auth.uid() IS NOT NULL);

-- Политики безопасности для profiles
CREATE POLICY "Users can view their own profile" ON profiles
    FOR SELECT USING (auth.uid() = id);

CREATE POLICY "Users can insert their own profile" ON profiles
    FOR INSERT WITH CHECK (auth.uid() = id);

CREATE POLICY "Users can update their own profile" ON profiles
    FOR UPDATE USING (auth.uid() = id);

-- Индексы для производительности
CREATE INDEX IF NOT EXISTS idx_auth_audit_username ON auth_audit(username);
CREATE INDEX IF NOT EXISTS idx_auth_audit_email ON auth_audit(email);
CREATE INDEX IF NOT EXISTS idx_profiles_username ON profiles(username);
CREATE INDEX IF NOT EXISTS idx_profiles_email ON profiles(email);
