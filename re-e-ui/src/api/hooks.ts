import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "./mock";

const invalidateNodes = () => {
  const qc = useQueryClient();
  return () => qc.invalidateQueries({ queryKey: ["nodes"] });
};

export const useNodes = () => useQuery({ queryKey: ["nodes"], queryFn: api.listNodes });
export const useStats = () => useQuery({ queryKey: ["stats"], queryFn: api.getStats });
export const useFailures = () => useQuery({ queryKey: ["failures"], queryFn: api.getFailures });
export const useGateway = () => useQuery({ queryKey: ["gateway"], queryFn: api.getGateway });

export const useTestConnection = () => useMutation({ mutationFn: api.testConnection });
export const useAddNode = () => useMutation({ mutationFn: api.addNode, onSuccess: invalidateNodes() });
export const useRemoveNode = () =>
  useMutation({ mutationFn: api.removeNode, onSuccess: invalidateNodes() });
export const useResetBreaker = () =>
  useMutation({ mutationFn: api.resetBreaker, onSuccess: invalidateNodes() });
export const useTestNode = () =>
  useMutation({ mutationFn: (id: string) => api.testNode(id), onSuccess: invalidateNodes() });
