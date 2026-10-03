export type Json = string | number | boolean | null | { [key: string]: Json | undefined } | Json[];

export type Database = {
  // Allows to automatically instantiate createClient with right options
  // instead of createClient<Database, { PostgrestVersion: 'XX' }>(URL, KEY)
  __InternalSupabase: {
    PostgrestVersion: "14.15";
  };
  public: {
    Tables: {
      gym_workspaces: {
        Row: {
          id: string;
          owner_id: string;
          gym_id: string;
          state: Json;
          revision: number;
          created_at: string;
          updated_at: string;
        };
        Insert: {
          id?: string;
          owner_id: string;
          gym_id: string;
          state?: Json;
          revision?: number;
          created_at?: string;
          updated_at?: string;
        };
        Update: {
          id?: string;
          owner_id?: string;
          gym_id?: string;
          state?: Json;
          revision?: number;
          created_at?: string;
          updated_at?: string;
        };
        Relationships: [];
      };
      gyms: {
        Row: {
          id: string;
          owner_user_id: string;
          name: string;
          subscription_plan: string;
          subscription_status: string;
          trial_ends_at: string | null;
          created_at: string;
          updated_at: string;
        };
        Insert: {
          id?: string;
          owner_user_id: string;
          name: string;
          subscription_plan?: string;
          subscription_status?: string;
          trial_ends_at?: string | null;
          created_at?: string;
          updated_at?: string;
        };
        Update: {
          id?: string;
          owner_user_id?: string;
          name?: string;
          subscription_plan?: string;
          subscription_status?: string;
          trial_ends_at?: string | null;
          created_at?: string;
          updated_at?: string;
        };
        Relationships: [];
      };
      gym_users: {
        Row: {
          gym_id: string;
          user_id: string;
          role: string;
          display_name: string;
          email: string;
          enabled: boolean;
          permissions: Json;
          created_at: string;
          updated_at: string;
        };
        Insert: {
          gym_id: string;
          user_id: string;
          role: string;
          display_name?: string;
          email?: string;
          enabled?: boolean;
          permissions?: Json;
          created_at?: string;
          updated_at?: string;
        };
        Update: {
          gym_id?: string;
          user_id?: string;
          role?: string;
          display_name?: string;
          email?: string;
          enabled?: boolean;
          permissions?: Json;
          created_at?: string;
          updated_at?: string;
        };
        Relationships: [];
      };
      audit_logs: {
        Row: {
          id: number;
          gym_id: string;
          user_id: string | null;
          role: string;
          action: string;
          entity_type: string | null;
          entity_id: string | null;
          metadata: Json;
          created_at: string;
        };
        Insert: {
          id?: number;
          gym_id: string;
          user_id?: string | null;
          role: string;
          action: string;
          entity_type?: string | null;
          entity_id?: string | null;
          metadata?: Json;
          created_at?: string;
        };
        Update: {
          id?: number;
          gym_id?: string;
          user_id?: string | null;
          role?: string;
          action?: string;
          entity_type?: string | null;
          entity_id?: string | null;
          metadata?: Json;
          created_at?: string;
        };
        Relationships: [];
      };
      api_rate_limits: {
        Row: {
          scope: string;
          subject: string;
          window_started_at: string;
          request_count: number;
          updated_at: string;
        };
        Insert: {
          scope: string;
          subject: string;
          window_started_at?: string;
          request_count?: number;
          updated_at?: string;
        };
        Update: {
          scope?: string;
          subject?: string;
          window_started_at?: string;
          request_count?: number;
          updated_at?: string;
        };
        Relationships: [];
      };
      subscription_entitlements: {
        Row: {
          owner_id: string;
          gym_id: string | null;
          status: string;
          source: string | null;
          provider_status: string | null;
          provider_source: string | null;
          provider_customer_id: string | null;
          provider_subscription_id: string | null;
          provider_period_end: string | null;
          recharge_period_end: string | null;
          current_period_end: string | null;
          last_verified_at: string;
          created_at: string;
          updated_at: string;
        };
        Insert: {
          owner_id: string;
          gym_id?: string | null;
          status?: string;
          source?: string | null;
          provider_status?: string | null;
          provider_source?: string | null;
          provider_customer_id?: string | null;
          provider_subscription_id?: string | null;
          provider_period_end?: string | null;
          recharge_period_end?: string | null;
          current_period_end?: string | null;
          last_verified_at?: string;
          created_at?: string;
          updated_at?: string;
        };
        Update: {
          owner_id?: string;
          gym_id?: string | null;
          status?: string;
          source?: string | null;
          provider_status?: string | null;
          provider_source?: string | null;
          provider_customer_id?: string | null;
          provider_subscription_id?: string | null;
          provider_period_end?: string | null;
          recharge_period_end?: string | null;
          current_period_end?: string | null;
          last_verified_at?: string;
          created_at?: string;
          updated_at?: string;
        };
        Relationships: [];
      };
      recharge_codes: {
        Row: {
          id: string;
          code_hash: string;
          duration_days: number;
          batch_label: string | null;
          valid_until: string | null;
          redeemed_by: string | null;
          redeemed_at: string | null;
          created_at: string;
        };
        Insert: {
          id?: string;
          code_hash: string;
          duration_days?: number;
          batch_label?: string | null;
          valid_until?: string | null;
          redeemed_by?: string | null;
          redeemed_at?: string | null;
          created_at?: string;
        };
        Update: {
          id?: string;
          code_hash?: string;
          duration_days?: number;
          batch_label?: string | null;
          valid_until?: string | null;
          redeemed_by?: string | null;
          redeemed_at?: string | null;
          created_at?: string;
        };
        Relationships: [];
      };
    };
    Views: {
      [_ in never]: never;
    };
    Functions: {
      get_current_gym_context: {
        Args: Record<PropertyKey, never>;
        Returns: Json;
      };
      ensure_owner_gym: {
        Args: { p_name: string; p_initial_state: Json };
        Returns: Json;
      };
      load_current_gym_workspace: {
        Args: Record<PropertyKey, never>;
        Returns: Json;
      };
      save_current_gym_workspace: {
        Args: { p_state: Json; p_expected_revision: number };
        Returns: Json;
      };
      record_audit_event: {
        Args: {
          p_action: string;
          p_entity_type?: string | null;
          p_entity_id?: string | null;
          p_metadata?: Json;
        };
        Returns: undefined;
      };
      consume_api_rate_limit: {
        Args: { p_scope: string; p_subject: string; p_limit: number; p_window_seconds: number };
        Returns: boolean;
      };
      redeem_recharge_code: {
        Args: { p_code: string };
        Returns: Json;
      };
    };
    Enums: {
      [_ in never]: never;
    };
    CompositeTypes: {
      [_ in never]: never;
    };
  };
};

type DatabaseWithoutInternals = Omit<Database, "__InternalSupabase">;

type DefaultSchema = DatabaseWithoutInternals[Extract<keyof Database, "public">];

export type Tables<
  DefaultSchemaTableNameOrOptions extends
    | keyof (DefaultSchema["Tables"] & DefaultSchema["Views"])
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends (DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals;
  }
    ? keyof (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
        DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])
    : never) = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals;
}
  ? (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
      DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])[TableName] extends {
      Row: infer R;
    }
    ? R
    : never
  : DefaultSchemaTableNameOrOptions extends keyof (DefaultSchema["Tables"] & DefaultSchema["Views"])
    ? (DefaultSchema["Tables"] & DefaultSchema["Views"])[DefaultSchemaTableNameOrOptions] extends {
        Row: infer R;
      }
      ? R
      : never
    : never;

export type TablesInsert<
  DefaultSchemaTableNameOrOptions extends
    keyof DefaultSchema["Tables"] | { schema: keyof DatabaseWithoutInternals },
  TableName extends (DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals;
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never) = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals;
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Insert: infer I;
    }
    ? I
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Insert: infer I;
      }
      ? I
      : never
    : never;

export type TablesUpdate<
  DefaultSchemaTableNameOrOptions extends
    keyof DefaultSchema["Tables"] | { schema: keyof DatabaseWithoutInternals },
  TableName extends (DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals;
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never) = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals;
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Update: infer U;
    }
    ? U
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Update: infer U;
      }
      ? U
      : never
    : never;

export type Enums<
  DefaultSchemaEnumNameOrOptions extends
    keyof DefaultSchema["Enums"] | { schema: keyof DatabaseWithoutInternals },
  EnumName extends (DefaultSchemaEnumNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals;
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"]
    : never) = never,
> = DefaultSchemaEnumNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals;
}
  ? DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"][EnumName]
  : DefaultSchemaEnumNameOrOptions extends keyof DefaultSchema["Enums"]
    ? DefaultSchema["Enums"][DefaultSchemaEnumNameOrOptions]
    : never;

export type CompositeTypes<
  PublicCompositeTypeNameOrOptions extends
    keyof DefaultSchema["CompositeTypes"] | { schema: keyof DatabaseWithoutInternals },
  CompositeTypeName extends (PublicCompositeTypeNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals;
  }
    ? keyof DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"]
    : never) = never,
> = PublicCompositeTypeNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals;
}
  ? DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"][CompositeTypeName]
  : PublicCompositeTypeNameOrOptions extends keyof DefaultSchema["CompositeTypes"]
    ? DefaultSchema["CompositeTypes"][PublicCompositeTypeNameOrOptions]
    : never;

export const Constants = {
  public: {
    Enums: {},
  },
} as const;
