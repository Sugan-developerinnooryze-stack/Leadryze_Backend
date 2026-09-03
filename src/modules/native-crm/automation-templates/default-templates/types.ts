import { IFlowNode, IFlowEdge } from '../../automation-flows/automation-flow.model';
import { PipelineModule } from '../../pipeline-config/pipeline-config.model';

export interface IDefaultTemplate {
  name: string;
  description: string;
  category: string;
  triggerModule: PipelineModule;
  nodes: IFlowNode[];
  edges: IFlowEdge[];
}
