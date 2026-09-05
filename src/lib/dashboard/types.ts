/* Shapes of the JSON files the dashboard reads (build time). */

export interface CalendarEntry {
  date: string;                       // YYYY-MM-DD
  platform: string;                   // Instagram, TikTok, X, LinkedIn...
  format: string;                     // Reel, Carousel, Story, Post...
  pillar: string;                     // content pillar
  topic: { en: string; ar: string };
  caption: { en: string; ar: string };
  hashtags: string[];
  image?: string | null;
  status?: 'planned' | 'drafted' | 'published' | string;
}

export type IntegrationStatus = 'live' | 'pending-owner' | 'pending-agent' | 'planned';
export interface Integration {
  id: string;
  name: string;
  status: IntegrationStatus | string;
  owner: string;
  action: string;
  link?: string | null;
  detail?: string | null;
}

export interface ChecklistItem {
  id: string;
  group: string;
  text: string;
  owner: 'agent' | 'owner' | string;
  link?: string | null;
}

export interface QuickLink { label: string; url: string; note: string }
export interface Section { id: string; label: string }
