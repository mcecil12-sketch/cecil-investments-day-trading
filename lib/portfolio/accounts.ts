import { prisma } from "@/lib/prisma";
import type { Account, AccountType } from "@/lib/generated/prisma";

export interface CreateAccountInput {
  name: string;
  type: AccountType;
  institution: string;
  externalId?: string | null;
  isLocked?: boolean;
}

export interface UpdateAccountInput {
  name?: string;
  type?: AccountType;
  institution?: string;
  externalId?: string | null;
  isLocked?: boolean;
}

export function listAccounts(): Promise<Account[]> {
  return prisma.account.findMany({ orderBy: { createdAt: "asc" } });
}

export function getAccount(id: string): Promise<Account | null> {
  return prisma.account.findUnique({ where: { id } });
}

export function createAccount(input: CreateAccountInput): Promise<Account> {
  return prisma.account.create({
    data: {
      name: input.name,
      type: input.type,
      institution: input.institution,
      externalId: input.externalId ?? null,
      isLocked: input.isLocked ?? false,
    },
  });
}

export function updateAccount(id: string, input: UpdateAccountInput): Promise<Account> {
  return prisma.account.update({ where: { id }, data: input });
}

export function deleteAccount(id: string): Promise<Account> {
  return prisma.account.delete({ where: { id } });
}
