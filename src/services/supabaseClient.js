import { createClient } from '@supabase/supabase-js';

const supabaseUrl = import.meta.env.VITE_SUPABASE_URL || 'https://rzmurrurwictxxdgczch.supabase.co';
const supabaseAnonKey = import.meta.env.VITE_SUPABASE_ANON_KEY || 'sb_publishable_o0pY2XsnR33Z0nesd_gx1g_UJ9-FgwK';

export const supabase = createClient(supabaseUrl, supabaseAnonKey);

