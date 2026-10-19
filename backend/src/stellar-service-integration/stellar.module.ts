import { Module } from "@nestjs/common";
import { ConfigModule } from "@nestjs/config";
import { StellarService } from "./stellar.service";
import { StellarEndpointPool } from "./stellar-endpoint-pool.service";

@Module({
  imports: [ConfigModule],
  providers: [StellarEndpointPool, StellarService],
  exports: [StellarEndpointPool, StellarService],
})
export class StellarModule {}